// A member's garden as a git address (routes/git.ts, services/gitHttp.ts),
// driven by the real git client over HTTP. What is held down: a member clones
// and fetches their own garden with their git token, over both protocol
// versions; no token, a wrong one, an `mcp` one, or a git token on someone
// else's garden is refused; a push is refused in words; only branches and
// tags travel; a garden that is not a repository yet becomes one at the first
// clone, and one inside another repository is never served; the git token
// opens nothing else; GET /api/me/git hands out a stable token and the
// household's public address, and rotating it shuts the old one out.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-git-clone-"));
const GARDENS = path.join(TMP, "gardens");
const WORK = path.join(TMP, "work");
fs.mkdirSync(GARDENS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const { createSession } = await import("../src/services/auth");
const { createApiToken, requireAuth } = await import("../src/middleware/auth");
const gitRoutes = (await import("../src/routes/git")).default;
const meRoutes = (await import("../src/routes/me")).default;

const app = new Hono();
app.route("/git", gitRoutes);
app.route("/api/me", meRoutes);
app.get("/api/probe", requireAuth, (c) => c.json({ ok: true }));

// The client side never reads the developer's own git config: no keychain
// helper storing test tokens, no prompt waiting for a password.
const CLIENT_ENV = {
  PATH: process.env.PATH!,
  HOME: TMP,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

/** The git client, asynchronously: the server answering it runs in this process. */
async function client(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, env: CLIENT_ENV, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}

const local = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env: CLIENT_ENV, encoding: "utf8" });

let server: ReturnType<typeof Bun.serve>;
let base = "";
const A = "gc-ada", B = "gc-ben", C = "gc-cleo", D = "gc-dora", E = "gc-emil", F = "gc-faye";
const tokens: Record<string, string> = {};

function member(id: string, username: string) {
  db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, username, username]);
}

function gardenRepo(username: string, note: string) {
  const root = path.join(GARDENS, username);
  fs.mkdirSync(path.join(root, "notes", "en"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "en", "first.md"), note);
  local(root, "init", "-q", "--initial-branch=main");
  local(root, "add", "-A");
  local(root, "commit", "-qm", "first note");
  return root;
}

const url = (username: string, token?: string) =>
  token ? base.replace("http://", `http://anyone:${encodeURIComponent(token)}@`) + `/git/${username}.git` : `${base}/git/${username}.git`;

beforeAll(async () => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, u] of [["u-a", A], ["u-b", B], ["u-c", C], ["u-d", D], ["u-e", E], ["u-f", F]] as const) member(id, u);
  const ada = gardenRepo(A, "ada's note\n");
  gardenRepo(B, "ben's private note\n");
  // Refs that must not travel: a remote-tracking branch, what a history
  // rewrite leaves behind, a stash.
  const head = local(ada, "rev-parse", "HEAD").stdout.trim();
  local(ada, "update-ref", "refs/remotes/origin/main", head);
  local(ada, "update-ref", "refs/original/refs/heads/main", head);
  local(ada, "tag", "v1");
  // A stash: an object no ref that travels points to.
  fs.writeFileSync(path.join(ada, "wip.md"), "stashed work in progress\n");
  local(ada, "add", "wip.md");
  local(ada, "stash", "-q");
  // Cleo's garden is plain files; Dora's sits inside a repository over all gardens.
  fs.mkdirSync(path.join(GARDENS, C, "notes"), { recursive: true });
  fs.writeFileSync(path.join(GARDENS, C, "notes", "hello.md"), "cleo\n");
  // A database left in a garden: never committed.
  fs.writeFileSync(path.join(GARDENS, C, "stray.db"), "SQLite format 3");
  // Emil's garden: an init whose first commit never happened.
  fs.mkdirSync(path.join(GARDENS, E, "notes"), { recursive: true });
  fs.writeFileSync(path.join(GARDENS, E, "notes", "emil.md"), "emil\n");
  local(path.join(GARDENS, E), "init", "-q", "--initial-branch=main");
  // Faye's garden: plain files, two first clones at once.
  fs.mkdirSync(path.join(GARDENS, F), { recursive: true });
  fs.writeFileSync(path.join(GARDENS, F, "faye.md"), "faye\n");

  tokens.ada = (await createApiToken("u-a", "git-clone", "git", true)).rawToken;
  tokens.adaFull = (await createApiToken("u-a", "everything", "full")).rawToken;
  tokens.adaMcp = (await createApiToken("u-a", "mcp-settings", "mcp", true)).rawToken;
  tokens.ben = (await createApiToken("u-b", "git-clone", "git", true)).rawToken;
  tokens.cleo = (await createApiToken("u-c", "git-clone", "git", true)).rawToken;
  tokens.dora = (await createApiToken("u-d", "git-clone", "git", true)).rawToken;
  tokens.emil = (await createApiToken("u-e", "git-clone", "git", true)).rawToken;
  tokens.faye = (await createApiToken("u-f", "git-clone", "git", true)).rawToken;

  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("cloning", () => {
  for (const version of ["0", "2"]) {
    test(`a member clones and fetches their own garden (client asking for protocol v${version})`, async () => {
      const dest = path.join(WORK, `ada-v${version}`);
      const r = await client(WORK, "-c", `protocol.version=${version}`, "clone", "-q", url(A, tokens.ada), dest);
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(dest, "notes", "en", "first.md"), "utf8")).toBe("ada's note\n");

      // A new commit on the server reaches the clone by fetch — the request
      // that carries the clone's haves.
      const ada = path.join(GARDENS, A);
      fs.writeFileSync(path.join(ada, "notes", "en", `second-v${version}.md`), "more\n");
      local(ada, "add", "-A");
      local(ada, "commit", "-qm", "second note");
      const pull = await client(dest, "-c", `protocol.version=${version}`, "pull", "-q", "--ff-only");
      expect(pull.code).toBe(0);
      expect(fs.existsSync(path.join(dest, "notes", "en", `second-v${version}.md`))).toBe(true);
    });
  }

  test("a full token clones too", async () => {
    const r = await client(WORK, "clone", "-q", url(A, tokens.adaFull), path.join(WORK, "ada-full"));
    expect(r.code).toBe(0);
  });

  test("only branches and tags are advertised", async () => {
    const r = await client(WORK, "ls-remote", url(A, tokens.ada));
    expect(r.code).toBe(0);
    const refs = r.out.split("\n").filter(Boolean).map((l) => l.split("\t")[1] ?? "");
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/tags/v1");
    expect(refs.some((x) => x.startsWith("refs/remotes/") || x.startsWith("refs/original/") || x === "refs/stash")).toBe(false);
  });

  test("an object no advertised ref points to cannot be fetched by its id, in either protocol", async () => {
    const stash = local(path.join(GARDENS, A), "rev-parse", "refs/stash").stdout.trim();
    expect(stash).toMatch(/^[0-9a-f]{40}$/);
    const dest = path.join(WORK, "ada-stash");
    expect((await client(WORK, "clone", "-q", url(A, tokens.ada), dest)).code).toBe(0);
    for (const version of ["2", "0"]) {
      const r = await client(dest, "-c", `protocol.version=${version}`, "fetch", "origin", stash);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("not allow request for unadvertised object");
    }
    expect(local(dest, "cat-file", "-e", stash).status).not.toBe(0);
  });
});

describe("refusals", () => {
  test("without a token, git is asked for one and gets nothing", async () => {
    const res = await fetch(`${url(A)}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    const r = await client(WORK, "clone", "-q", url(A), path.join(WORK, "anon"));
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(WORK, "anon", "notes"))).toBe(false);
  });

  test("a wrong token and an mcp token are refused", async () => {
    for (const t of ["maur_not-a-token", tokens.adaMcp]) {
      const res = await fetch(`${url(A, t)}/info/refs?service=git-upload-pack`.replace(/\/\/[^@]+@/, "//"), {
        headers: { Authorization: `Basic ${btoa(`x:${t}`)}` },
      });
      expect(res.status).toBe(401);
    }
  });

  test("a member's token does not open another member's garden", async () => {
    const r = await client(WORK, "clone", "-q", url(B, tokens.ada), path.join(WORK, "ben-by-ada"));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("This garden is not yours.");
    expect(fs.existsSync(path.join(WORK, "ben-by-ada", "notes"))).toBe(false);
    // Nor does the full one, nor a direct upload-pack request.
    const res = await fetch(`${base}/git/${B}.git/git-upload-pack`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`x:${tokens.adaFull}`)}`, "Content-Type": "application/x-git-upload-pack-request" },
      body: "0000",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("ben's private note");
  });

  test("a push is refused, in words", async () => {
    const dest = path.join(WORK, "ada-push");
    expect((await client(WORK, "clone", "-q", url(A, tokens.ada), dest)).code).toBe(0);
    fs.writeFileSync(path.join(dest, "from-obsidian.md"), "hi\n");
    local(dest, "add", "-A");
    local(dest, "commit", "-qm", "from the vault");
    const r = await client(dest, "push", "-q", "origin", "main");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("read-only");
    expect(fs.existsSync(path.join(GARDENS, A, "from-obsidian.md"))).toBe(false);

    const res = await fetch(`${base}/git/${A}.git/git-receive-pack`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`x:${tokens.ada}`)}` },
      body: "0000",
    });
    expect(res.status).toBe(403);
  });

  test("the dumb protocol and other paths are not served", async () => {
    const auth = { Authorization: `Basic ${btoa(`x:${tokens.ada}`)}` };
    expect((await fetch(`${url(A)}/info/refs`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${url(A)}/HEAD`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${url(A)}/objects/info/packs`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/git/../${B}.git/info/refs?service=git-upload-pack`, { headers: auth })).status).not.toBe(200);
  });

  test("the git token opens nothing but the clone", async () => {
    const res = await fetch(`${base}/api/probe`, { headers: { Authorization: `Bearer ${tokens.ada}` } });
    expect(res.status).toBe(401);
    const me = await fetch(`${base}/api/me/git`, { headers: { Authorization: `Bearer ${tokens.ada}` } });
    expect(me.status).toBe(401);
  });
});

describe("the garden's repository", () => {
  test("a garden that is plain files becomes a repository at the first clone", async () => {
    expect(fs.existsSync(path.join(GARDENS, C, ".git"))).toBe(false);
    const dest = path.join(WORK, "cleo");
    const r = await client(WORK, "clone", "-q", url(C, tokens.cleo), dest);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dest, "notes", "hello.md"), "utf8")).toBe("cleo\n");
    const ignore = fs.readFileSync(path.join(GARDENS, C, ".gitignore"), "utf8");
    expect(ignore).toContain(".obsidian/");
    expect(ignore).toContain("*.db");
    // The database left in it never entered the history.
    expect(local(path.join(GARDENS, C), "ls-files").stdout).not.toContain("stray.db");
    expect(fs.existsSync(path.join(dest, "stray.db"))).toBe(false);
    // Its export was written before the first clone was served, and came with it.
    expect(fs.existsSync(path.join(dest, "_maurice", "README.md"))).toBe(true);
    expect(local(dest, "log", "-1", "--format=%an", "--", "_maurice").stdout.trim()).toBe("Maurice (export)");
    expect(local(path.join(GARDENS, C), "status", "--porcelain").stdout.trim()).toBe("");
  });

  test("a repository whose first commit never happened gets it, rather than being served empty", async () => {
    const dest = path.join(WORK, "emil");
    const r = await client(WORK, "clone", "-q", url(E, tokens.emil), dest);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("empty repository");
    expect(fs.readFileSync(path.join(dest, "notes", "emil.md"), "utf8")).toBe("emil\n");
  });

  test("two first clones at once make one repository with one first commit", async () => {
    const [x, y] = await Promise.all([
      client(WORK, "clone", "-q", url(F, tokens.faye), path.join(WORK, "faye-1")),
      client(WORK, "clone", "-q", url(F, tokens.faye), path.join(WORK, "faye-2")),
    ]);
    expect(x.code).toBe(0);
    expect(y.code).toBe(0);
    const subjects = local(path.join(GARDENS, F), "log", "--format=%s").stdout.trim().split("\n");
    expect(subjects.filter((l) => l === "Garden under version control")).toHaveLength(1);
  });

  test("a garden inside another repository is never served", async () => {
    const outer = path.join(TMP, "outer");
    fs.mkdirSync(path.join(outer, D), { recursive: true });
    fs.writeFileSync(path.join(outer, D, "note.md"), "dora\n");
    fs.writeFileSync(path.join(outer, "someone-else.md"), "not dora's\n");
    local(outer, "init", "-q");
    // Point Dora's garden at the nested directory for this test.
    fs.symlinkSync(path.join(outer, D), path.join(GARDENS, D));
    const res = await fetch(`${url(D)}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Basic ${btoa(`x:${tokens.dora}`)}` },
    });
    expect(res.status).toBe(409);
    expect(fs.existsSync(path.join(outer, D, ".git"))).toBe(false);
  });
});

describe("GET /api/me/git", () => {
  test("hands out the public address and one stable token; rotating shuts the old one out", async () => {
    const { token: session } = createSession("u-b");
    const headers = { Authorization: `Bearer ${session}`, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "maison.example" };
    const first = await (await fetch(`${base}/api/me/git`, { headers })).json() as { url: string; username: string; token: string };
    expect(first.url).toBe(`https://maison.example/git/${B}.git`);
    expect(first.username).toBe(B);
    expect(first.token).toBe(tokens.ben!);
    const again = await (await fetch(`${base}/api/me/git`, { headers })).json() as { token: string };
    expect(again.token).toBe(first.token);

    const rotated = await (await fetch(`${base}/api/me/git/rotate`, { method: "POST", headers })).json() as { token: string };
    expect(rotated.token).not.toBe(first.token);
    const old = await fetch(`${url(B)}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Basic ${btoa(`x:${first.token}`)}` } });
    expect(old.status).toBe(401);
    const fresh = await client(WORK, "clone", "-q", url(B, rotated.token), path.join(WORK, "ben"));
    expect(fresh.code).toBe(0);
    const scope = db.query(`SELECT scope FROM api_tokens WHERE token_plain = ?`).get(rotated.token) as { scope: string };
    expect(scope.scope).toBe("git");
  });
});
