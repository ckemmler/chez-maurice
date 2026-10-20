/**
 * A member's garden over git's smart HTTP protocol, read-only (17 October
 * 2026). routes/git.ts decides who may ask; this file answers.
 *
 * The protocol is git's own: `git http-backend`, the CGI program git ships,
 * run once per request with the request described in its environment. Nothing
 * of the protocol is reimplemented here — only the CGI plumbing around it.
 *
 * What is served is the garden's own repository, the live `.git` beside the
 * notes, not the bare remote some gardens push to: it is always current, and
 * a hosted household has no bare remote at all. Upload-pack only — receive-pack
 * is refused before this file is reached, and disabled here as well. Only
 * branches and tags are advertised, and in protocol v0 — the only one served —
 * only what is advertised can be fetched: `refs/remotes/*`, `refs/stash`, and
 * the `refs/original/*` a history rewrite leaves behind (services/mailForget.ts)
 * stay on the server.
 */

import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ensureIgnored } from "./gardenIgnore";

/** The request body git sends for a fetch is its list of wants and haves:
 *  kilobytes. Anything near this is not a git client. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/** Config handed to http-backend and the upload-pack it runs, through git's
 *  GIT_CONFIG_COUNT environment (git ≥ 2.31), so no repository is edited. */
const SERVE_CONFIG: [string, string][] = [
  ["http.receivepack", "false"],
  ["http.uploadpack", "true"],
  ["http.getanyfile", "false"],
  ["uploadpack.hiderefs", "refs/"],
  ["uploadpack.hiderefs", "!refs/heads/"],
  ["uploadpack.hiderefs", "!refs/tags/"],
];

/** `git` in `root`, without holding the server's event loop: making a large
 *  garden a repository (`git add -A` over gigabytes of images) takes minutes. */
async function git(cwd: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { status: await p.exited, stdout, stderr };
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Is `root` the top of a repository of its own — not a plain directory, and
 *  not a directory inside some other repository? */
export function isOwnRepo(root: string): boolean {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  return top.status === 0 && real(top.stdout.trim()) === real(root);
}

/** One preparation per garden at a time: two first clones arriving together
 *  share the same `git init` rather than racing two. */
const preparing = new Map<string, Promise<RepoState>>();

type RepoState = { ok: true; created: boolean } | { ok: false; reason: string };

/**
 * Make sure `root` is a repository of its own with at least one commit,
 * making it so the first time a clone is asked for. From then on every write
 * to the garden is committed there (gardenFiche.autoCommit, the garden tool's
 * _auto_commit), as at home. `created` is true when this call made the first
 * commit.
 *
 * Refused, with the reason, when the garden sits inside another repository —
 * a development checkout with one repository over every garden: serving it
 * would hand out everyone's notes, and nesting a new one would hide this
 * garden from it.
 */
export function ensureGardenRepo(root: string): Promise<RepoState> {
  const key = real(root);
  const going = preparing.get(key);
  if (going) return going;
  const run = prepare(root).finally(() => preparing.delete(key));
  preparing.set(key, run);
  return run;
}

async function prepare(root: string): Promise<RepoState> {
  const top = await git(root, "rev-parse", "--show-toplevel");
  if (top.status === 0 && real(top.stdout.trim()) !== real(root)) {
    return { ok: false, reason: "these notes are inside another repository" };
  }
  // A repository with a commit is ready. One without — an init whose first
  // commit failed — is finished now rather than served empty for ever.
  if (top.status === 0 && (await git(root, "rev-parse", "--verify", "--quiet", "HEAD")).status === 0) {
    return { ok: true, created: false };
  }
  if (top.status !== 0) {
    const init = await git(root, "init", "--quiet", "--initial-branch=main");
    if (init.status !== 0) return { ok: false, reason: `git init failed: ${init.stderr.trim()}` };
  }

  ensureIgnored(root);
  // A server with no git identity (a fresh container) could not commit at all:
  // give this repository one rather than let every later write fail silently.
  if ((await git(root, "var", "GIT_AUTHOR_IDENT")).status !== 0) {
    await git(root, "config", "user.name", "Maurice");
    await git(root, "config", "user.email", "maurice@localhost");
  }

  const add = await git(root, "add", "-A");
  if (add.status !== 0) return { ok: false, reason: `first commit failed: ${add.stderr.trim()}` };
  const commit = await git(root, "commit", "--quiet", "--allow-empty", "-m", "Notes under version control");
  if (commit.status !== 0) return { ok: false, reason: `first commit failed: ${commit.stderr.trim()}` };
  return { ok: true, created: true };
}

/** Is `root` a directory? */
export function isGardenDir(root: string): boolean {
  try { return statSync(root).isDirectory(); } catch { return false; }
}

/**
 * Run `git http-backend` for one request against the repository at `root`.
 * `pathInfo` is what follows `<member>.git` in the URL: `/info/refs` or
 * `/git-upload-pack`.
 */
export async function serveGitHttp(req: Request, root: string, pathInfo: string, remoteUser: string): Promise<Response> {
  const url = new URL(req.url);
  let body: Uint8Array | null = null;
  if (req.method === "POST") {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_REQUEST_BYTES) return text(413, "Request too large.");
    body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > MAX_REQUEST_BYTES) return text(413, "Request too large.");
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: pathInfo,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    REMOTE_USER: remoteUser,
    REMOTE_ADDR: "127.0.0.1",
    GIT_CONFIG_COUNT: String(SERVE_CONFIG.length),
  };
  SERVE_CONFIG.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  const type = req.headers.get("content-type");
  if (type) env.CONTENT_TYPE = type;
  if (body) env.CONTENT_LENGTH = String(body.byteLength);
  // A large fetch request arrives gzipped; http-backend inflates it itself.
  const encoding = req.headers.get("content-encoding");
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  // The `Git-Protocol: version=2` header a client sends is deliberately NOT
  // passed on (HTTP_GIT_PROTOCOL): in protocol v2, upload-pack hands out any
  // object a client names by its id, hidden refs included — a stash, or what
  // a history rewrite took out. Protocol v0 sends only what it advertised.
  // Every client falls back to it; Obsidian Git on a phone speaks nothing else.

  const proc = Bun.spawn(["git", "http-backend"], {
    env,
    stdin: body ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  proc.exited.then(async (code) => {
    if (code !== 0) console.error(`[git] http-backend exited ${code}: ${(await stderr).trim().slice(-400)}`);
  });

  return cgiResponse(proc.stdout);
}

/** Turn a CGI program's output — headers, a blank line, the body — into a
 *  Response whose body streams on as the program writes it. */
async function cgiResponse(stdout: ReadableStream<Uint8Array>): Promise<Response> {
  const reader = stdout.getReader();
  let head = new Uint8Array(0);
  let split = -1;
  let sepLen = 0;
  while (split < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(head.byteLength + value.byteLength);
    joined.set(head);
    joined.set(value, head.byteLength);
    head = joined;
    for (let i = 0; i < head.byteLength - 1; i++) {
      if (head[i] === 10 && head[i + 1] === 10) { split = i; sepLen = 2; break; }
      if (i < head.byteLength - 3 && head[i] === 13 && head[i + 1] === 10 && head[i + 2] === 13 && head[i + 3] === 10) {
        split = i; sepLen = 4; break;
      }
    }
    if (head.byteLength > 64 * 1024 && split < 0) break;
  }
  if (split < 0) {
    reader.cancel().catch(() => {});
    return text(500, "The git backend gave no answer.");
  }

  let status = 200;
  const headers = new Headers();
  for (const line of new TextDecoder().decode(head.subarray(0, split)).split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === "status") status = parseInt(value, 10) || 200;
    else headers.append(name, value);
  }

  const rest = head.subarray(split + sepLen);
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { if (rest.byteLength) ctrl.enqueue(rest); },
    async pull(ctrl) {
      const { value, done } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

/** A plain-text answer: git prints a text/plain error body to the user as
 *  `remote: …` lines. */
export function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message + "\n", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", ...headers },
  });
}
