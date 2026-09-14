/**
 * The stack under test: a seeded throwaway household, the Bun server, and one
 * garden engine per member — exactly the topology of a real install, on
 * ephemeral ports and directories. Used by Playwright's global setup and
 * teardown; nothing here knows about the tests.
 *
 * Which engine runs is the point of the whole chantier, so it is a switch:
 *   E2E_ENGINE=dev     `astro dev` per member (today)
 *   E2E_ENGINE=server  the built node server (phase 4)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const WEB = resolve(import.meta.dirname, "..");
export const REPO = resolve(WEB, "..");
export const SERVER = join(REPO, "server");
export const STATE_FILE = join(WEB, "e2e", ".state.json");

export type State = {
  root: string; dataDir: string; gardensDir: string;
  apiPort: number; ports: Record<string, number>;
  users: Record<string, string>; sessions: Record<string, string>;
  pids: number[]; engine: "dev" | "server";
};

export function readState(): State {
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

const API_PORT = Number(process.env.E2E_API_PORT || 3990);
const GARDEN_PORT_BASE = Number(process.env.E2E_GARDEN_PORT_BASE || 4400);
const ENGINE = (process.env.E2E_ENGINE || "dev") as State["engine"];

async function waitFor(url: string, ms: number, init?: RequestInit): Promise<void> {
  const until = Date.now() + ms;
  let last = "";
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

function log(line: string) { process.stdout.write(`[e2e] ${line}\n`); }

export async function startStack(): Promise<State> {
  // realpath: on macOS $TMPDIR is under /var → /private/var, and git reports
  // the real path, which the engine's autoCommit compares against ours.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "maurice-e2e-"));
  const dataDir = join(root, "data");
  const gardensDir = join(root, "gardens");
  const stateJson = join(root, "seed.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, "config.toml"), `[paths]\ndata_dir = "${join(root, "life")}"\n`);

  const base = {
    ...process.env,
    MAURICE_DATA_DIR: dataDir,
    MAURICE_GARDENS_DIR: gardensDir,
    MAURICE_CONFIG: join(root, "config.toml"),
    MAURICE_TLS_CERT: "/nonexistent",
    MAURICE_TLS_KEY: "/nonexistent",
    E2E_GARDEN_PORT_BASE: String(GARDEN_PORT_BASE),
  };

  const seed = spawnSync("bun", [join(WEB, "e2e/fixtures/seed.ts"), stateJson], { cwd: SERVER, env: base, encoding: "utf8" });
  if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`);
  const seeded = JSON.parse(readFileSync(stateJson, "utf8"));
  const pids: number[] = [];
  const logs = join(root, "logs");
  mkdirSync(logs);

  const keep = (name: string, p: ChildProcess) => {
    if (!p.pid) throw new Error(`${name} did not start`);
    pids.push(p.pid);
    const out = join(logs, `${name}.log`);
    p.stdout?.on("data", (d) => writeFileSync(out, d, { flag: "a" }));
    p.stderr?.on("data", (d) => writeFileSync(out, d, { flag: "a" }));
  };

  // The Bun server. The default garden is hana's engine, so no extra process.
  const api = spawn("bun", ["index.ts"], {
    cwd: SERVER,
    env: { ...base, PORT: String(API_PORT), MAURICE_PORT_API: String(API_PORT), MAURICE_PORT_WEB: String(seeded.ports.hana),
      MAURICE_PORT_MCP_GATEWAY: "1", MAURICE_DEFAULT_GARDEN: "hana", MAURICE_PUBLIC_HOST: "localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  keep("api", api);

  // One engine per member, like start-garden.sh: a symlink shell of web/ so
  // each instance owns its cwd-keyed caches.
  for (const [member, port] of Object.entries(seeded.ports as Record<string, number>)) {
    const shell = join(root, "shells", member);
    mkdirSync(shell, { recursive: true });
    for (const entry of readdirSync(WEB)) {
      if (entry === "e2e" || entry.startsWith(".")) continue;
      symlinkSync(join(WEB, entry), join(shell, entry));
    }
    const env = { ...base, GARDEN: member, GARDEN_BASE: `/g/${member}`, GARDEN_SHELL: "1", WEB_SSR: "1", THEME: "manuscript" };
    const engine = ENGINE === "dev"
      ? spawn(join(WEB, "node_modules/.bin/astro"), ["dev", "--port", String(port), "--host", "127.0.0.1"], { cwd: shell, env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("node", [join(WEB, "dist/server/entry.mjs")], { cwd: shell, env: { ...env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
    keep(`engine-${member}`, engine);
  }

  const state: State = {
    root, dataDir, gardensDir, apiPort: API_PORT, ports: seeded.ports,
    users: seeded.users, sessions: seeded.sessions, pids, engine: ENGINE,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, 30_000);
  for (const [member, port] of Object.entries(state.ports)) {
    await waitFor(`http://127.0.0.1:${port}/g/${member}/`, 90_000);
    log(`engine ${member} up on :${port}`);
  }
  log(`api up on :${API_PORT} (${ENGINE}); logs in ${logs}`);
  return state;
}

export function stopStack(): void {
  if (!existsSync(STATE_FILE)) return;
  const state = readState();
  for (const pid of state.pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  // The engines' download-images integration symlinks web/public/images/<m>
  // and public/avatars/* into the gardens root — ours is about to vanish, and
  // a dangling symlink under public/ makes the next `astro build` fail.
  for (const dir of ["images", "avatars"]) {
    const base = join(WEB, "public", dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const p = join(base, entry);
      try {
        const target = readlinkSync(p);
        if (target.startsWith(state.root)) unlinkSync(p);
      } catch { /* not a symlink */ }
    }
  }
  if (!process.env.E2E_KEEP) rmSync(state.root, { recursive: true, force: true });
  else log(`kept ${state.root}`);
  rmSync(STATE_FILE, { force: true });
}
