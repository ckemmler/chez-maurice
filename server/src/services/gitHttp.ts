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
 * branches and tags are advertised: `refs/remotes/*`, `refs/stash`, and the
 * `refs/original/*` a history rewrite leaves behind (services/mailForget.ts)
 * stay on the server.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

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

/** Lines a new garden repository ignores: the system's litter and a vault's
 *  own settings, which belong to each device that opens the clone. */
const NEW_REPO_IGNORES = [".DS_Store", ".obsidian/", ".trash/"];

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

/**
 * Make sure `root` is a repository of its own, creating it the first time a
 * clone is asked for. From then on every write to the garden is committed
 * there (gardenFiche.autoCommit, the garden tool's _auto_commit), as at home.
 *
 * Refused, with the reason, when the garden sits inside another repository —
 * a development checkout with one repository over every garden: serving it
 * would hand out everyone's notes, and nesting a new one would hide this
 * garden from it.
 */
export function ensureGardenRepo(root: string): { ok: true; created: boolean } | { ok: false; reason: string } {
  const top = git(root, "rev-parse", "--show-toplevel");
  if (top.status === 0) {
    const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
    if (real(top.stdout.trim()) === real(root)) return { ok: true, created: false };
    return { ok: false, reason: "this garden is inside another repository" };
  }

  const init = git(root, "init", "--quiet", "--initial-branch=main");
  if (init.status !== 0) return { ok: false, reason: `git init failed: ${init.stderr.trim()}` };

  const ignore = join(root, ".gitignore");
  const had = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const missing = NEW_REPO_IGNORES.filter((l) => !had.split("\n").includes(l));
  if (missing.length) writeFileSync(ignore, (had && !had.endsWith("\n") ? had + "\n" : had) + missing.join("\n") + "\n");

  // A server with no git identity (a fresh container) could not commit at all:
  // give this repository one rather than let every later write fail silently.
  if (git(root, "var", "GIT_AUTHOR_IDENT").status !== 0) {
    git(root, "config", "user.name", "Maurice");
    git(root, "config", "user.email", "maurice@localhost");
  }

  git(root, "add", "-A");
  const commit = git(root, "commit", "--quiet", "-m", "Garden under version control");
  if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
    return { ok: false, reason: `first commit failed: ${commit.stderr.trim()}` };
  }
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
  // Protocol v2, which git asks for by this header.
  const proto = req.headers.get("git-protocol");
  if (proto) env.HTTP_GIT_PROTOCOL = proto;

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
