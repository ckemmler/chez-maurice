// ============================================================================
// demo-door.ts — the front door of the demo fleet.
//
// A stranger taps "Try Maurice" in the app, or fills the form on the web, and
// a live household is theirs a few seconds later. No account, no machine, no
// payment. This is the service that makes that true.
//
//   bun run ops/demo-door.ts          # listens on :7777
//
// It runs ON the demo host, beside the Docker socket it drives — unlike
// ops/household.sh, which reaches a host over ssh. One machine holds the whole
// fleet (a household is a few hundred MB; see infra/container/MULTI-HOUSEHOLD.md),
// so there is nothing to schedule across and nothing here that an orchestrator
// would do for us.
//
// ── Why creating a demo is a volume copy, not a seeding run ─────────────────
//
// The obvious design is "start an empty household, then run seed-demo.ts in
// it". It cannot work: that script refuses to run when MAURICE_DATA_DIR sits
// under a `.maurice` directory — which is exactly where a container's data
// lives — and rightly so, since the guard is what stops it overwriting a real
// household. Rather than punch a hole in a safety check, we seed ONCE into a
// template volume and every demo starts as a copy of it. That is faster (a
// file copy, not a program), identical every time, and leaves the guard alone.
//
// ── Why the subdomain is not the hard part ──────────────────────────────────
//
// One wildcard A record (`*.demo.chezmaurice.eu`, unproxied) covers every demo
// that will ever exist, so creating one involves no DNS call and no propagation
// wait. One wildcard certificate, obtained by Caddy over DNS-01, covers them
// too — which also keeps us away from Let's Encrypt's limit of 50 certificates
// per registered domain per week, a ceiling a churning demo fleet would hit in
// days if each name asked for its own. And with a wildcard certificate, a
// single static Caddy block routes the whole fleet by subdomain label, so there
// is no per-demo site file and no reload. See ops/demo-door.caddy.
//
// The hard part is elsewhere, and it is not infrastructure: every demo spends
// inference on our own key. Until §4's metering exists, the fuse is the TTL,
// the fleet cap, and one demo per address. Say so out loud rather than discover
// it on a bill.
// ============================================================================

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ── Configuration ───────────────────────────────────────────────────────────

const DIR = process.env.MAURICE_DEMO_DIR ?? "/opt/maurice";
const ZONE = process.env.MAURICE_DEMO_ZONE ?? "demo.chezmaurice.eu";
const TEMPLATE = process.env.MAURICE_DEMO_TEMPLATE ?? "maurice-demo-template_home";
const TTL_DAYS = Number(process.env.MAURICE_DEMO_TTL_DAYS ?? 14);
const FLEET_CAP = Number(process.env.MAURICE_DEMO_MAX ?? 20);
const PORT = Number(process.env.MAURICE_DEMO_PORT ?? 7777);
// Admin consoles are published on loopback only and nobody but the operator
// ever reaches them (ssh -L). They still need a port each, from a range that
// cannot collide with the hand-made households of ops/household.sh.
const ADMIN_PORT_BASE = Number(process.env.MAURICE_DEMO_ADMIN_PORT_BASE ?? 14000);

const COMPOSE = join(DIR, "compose.household.yml");
const ENV_DIR = join(DIR, "households");
const DB_PATH = join(DIR, "demo", "demos.db");

// ── The registry ────────────────────────────────────────────────────────────
//
// It is the record of intent; Docker is the record of fact. They drift — a
// process dies between `docker volume create` and `compose up` and leaves a
// half-made demo. `state` is what lets the reaper tell a demo still being born
// from one that was abandoned, so nothing here pretends the two can't diverge.

mkdirSync(join(DIR, "demo"), { recursive: true });
mkdirSync(ENV_DIR, { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS demos (
    name        TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    admin_port  INTEGER NOT NULL UNIQUE,
    state       TEXT NOT NULL,            -- creating | ready | failed | reaped
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS demos_state ON demos(state);
  CREATE INDEX IF NOT EXISTS demos_email ON demos(email);
`);

const q = {
  byName: db.query<DemoRow, [string]>("SELECT * FROM demos WHERE name = ?"),
  liveByEmail: db.query<DemoRow, [string]>(
    "SELECT * FROM demos WHERE email = ? AND state IN ('creating','ready')",
  ),
  liveCount: db.query<{ n: number }, []>(
    "SELECT count(*) AS n FROM demos WHERE state IN ('creating','ready')",
  ),
  portsTaken: db.query<{ admin_port: number }, []>(
    "SELECT admin_port FROM demos WHERE state IN ('creating','ready')",
  ),
  insert: db.query(
    `INSERT INTO demos (name, email, admin_port, state, created_at, expires_at)
     VALUES (?, ?, ?, 'creating', ?, ?)`,
  ),
  markReady: db.query("UPDATE demos SET state = 'ready' WHERE name = ?"),
  markFailed: db.query("UPDATE demos SET state = 'failed', error = ? WHERE name = ?"),
};

type DemoRow = {
  name: string;
  email: string;
  admin_port: number;
  state: "creating" | "ready" | "failed" | "reaped";
  created_at: number;
  expires_at: number;
  error: string | null;
};

// ── Names ───────────────────────────────────────────────────────────────────
//
// A demo's name is the first thing anyone sees of Maurice, and it is spoken
// aloud ("go to calm-otter dot demo..."), so: two short words, no digits, no
// ambiguity between what is heard and what is typed. Collisions are handled by
// the PRIMARY KEY, not by hoping.

const ADJECTIVES = `calm clear bright quiet warm gentle steady keen brave kind
  swift patient candid frank humble lucid modest nimble plain ready serene
  tidy vivid fond merry sober sunny trusty wise witty`.split(/\s+/);
const NOUNS = `otter heron badger marten linnet plover finch hare ibex lynx
  osprey pika quail raven shrike stoat swift teal vole wren auk brant crake
  eider godwit knot merlin ouzel petrel scaup`.split(/\s+/);

function proposeName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}`;
}

// ── Shelling out ────────────────────────────────────────────────────────────

async function run(cmd: string[], env?: Record<string, string>): Promise<string> {
  const p = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} → exit ${code}\n${err || out}`);
  return out;
}

// ── Creation ────────────────────────────────────────────────────────────────
//
// Serialised behind one promise chain. Two requests arriving together must not
// both read "19 demos, room for one more" and both create the twentieth, nor
// hand out the same admin port. The work is seconds and the fleet is small, so
// a queue is the right amount of machinery — no locks, no transactions across
// processes.

let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

function allocatePort(): number {
  const taken = new Set(q.portsTaken.all().map((r) => r.admin_port));
  for (let p = ADMIN_PORT_BASE; p < ADMIN_PORT_BASE + 500; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error("no free admin port in the demo range");
}

function allocateName(): string {
  for (let i = 0; i < 50; i++) {
    const name = proposeName();
    if (!q.byName.get(name)) return name;
  }
  throw new Error("could not find a free name in 50 tries");
}

export type Created = { name: string; host: string; url: string; expiresAt: number };

async function createDemo(email: string): Promise<Created> {
  return serialise(async () => {
    const existing = q.liveByEmail.get(email);
    if (existing) {
      // Not an error: someone who asks twice wants their demo, not a second one.
      return describe(existing);
    }
    if (q.liveCount.get()!.n >= FLEET_CAP) {
      throw Object.assign(new Error("the demo fleet is full"), { status: 503 });
    }

    const name = allocateName();
    const project = `demo-${name}`; // → container maurice-demo-<name>
    const host = `${name}.${ZONE}`;
    const port = allocatePort();
    const now = Date.now();
    const expiresAt = now + TTL_DAYS * 86_400_000;

    q.insert.run(name, email, port, now, expiresAt);

    try {
      // The env file compose reads. Shared secrets (the embedding endpoint and
      // key) come from the host's defaults.env, exactly as ops/household.sh
      // does it — a demo is a household like any other, it just has a deadline.
      const defaults = await Bun.file(join(DIR, "defaults.env")).text().catch(() => "");
      writeFileSync(
        join(ENV_DIR, `${project}.env`),
        [
          defaults.trimEnd(),
          `MAURICE_HOUSEHOLD=${project}`,
          `MAURICE_DOMAIN=${host}`,
          `MAURICE_ADMIN_PORT=${port}`,
          "",
        ].join("\n"),
      );

      // The data. A copy of the seeded template, never the template itself —
      // one demo writing into it would poison every demo made afterwards.
      const volume = `maurice-${project}_home`;
      await run(["docker", "volume", "create", volume]);
      await run([
        "docker", "run", "--rm",
        "-v", `${TEMPLATE}:/from:ro`,
        "-v", `${volume}:/to`,
        "alpine:3", "sh", "-c", "cp -a /from/. /to/",
      ]);

      await run([
        "docker", "compose",
        "-p", `maurice-${project}`,
        "--env-file", join(ENV_DIR, `${project}.env`),
        "-f", COMPOSE,
        "up", "-d",
      ]);

      await waitHealthy(port);
      q.markReady.run(name);
      return { name, host, url: `https://${host}`, expiresAt };
    } catch (e) {
      q.markFailed.run(String(e instanceof Error ? e.message : e), name);
      throw e;
    }
  });
}

// A container answers /healthz about a second and a half after `start` on a
// warm machine — longer on two ARM vCPUs. Wait rather than hand out an address
// that is not yet serving: the first impression is the product.
async function waitHealthy(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(400);
  }
  throw new Error(`the household never answered /healthz on :${port}`);
}

function describe(row: DemoRow): Created {
  return {
    name: row.name,
    host: `${row.name}.${ZONE}`,
    url: `https://${row.name}.${ZONE}`,
    expiresAt: row.expires_at,
  };
}

// ── The HTTP surface ────────────────────────────────────────────────────────
//
// Small on purpose. The app calls POST /api/demo and gets an address; that is
// the whole contract. Everything else is for the operator.

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // reached through Caddy; nothing else is on this network
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json({ ok: true, fleet: q.liveCount.get()!.n });

    if (url.pathname === "/api/demo" && req.method === "POST") {
      let body: { email?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "expected a JSON body" }, 400);
      }
      const email = (body.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) return json({ error: "a valid email address is required" }, 400);

      try {
        const created = await createDemo(email);
        return json(
          {
            ...created,
            // Said here so the app can say it too, in the words the operator
            // chose rather than words the client invented.
            notice:
              "This is a throwaway demo. It is deleted when it expires, and it is not the place for anything real.",
          },
          201,
        );
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        const message = status === 503
          ? "The demo fleet is full. Try again later."
          : "The demo could not be created.";
        if (status !== 503) console.error("[demo-door] create failed:", e);
        return json({ error: message }, status);
      }
    }

    const m = url.pathname.match(/^\/api\/demo\/([a-z-]+)$/);
    if (m && req.method === "GET") {
      const row = q.byName.get(m[1]);
      if (!row || row.state === "reaped") return json({ error: "no such demo" }, 404);
      return json({ ...describe(row), state: row.state });
    }

    return json({ error: "not found" }, 404);
  },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

console.log(
  `→ demo door on :${server.port} — zone ${ZONE}, cap ${FLEET_CAP}, ttl ${TTL_DAYS}d`,
);
