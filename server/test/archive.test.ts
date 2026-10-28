/**
 * The household archive round-trips: a tiny seeded data dir goes out as a
 * `maurice-archive` v1 tarball and comes back into a fresh dir, whole.
 *
 * The suite builds its own maurice.db with bun:sqlite rather than importing
 * src/db.ts: that module binds to one data dir per process (the preload's),
 * and the point here is to export from a dir of our choosing. The default
 * resolution — MAURICE_DATA_DIR and MAURICE_GARDENS_DIR — is covered by one
 * test that sets the env and imports the service dynamically, as the other
 * suites do for the data-api services.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-archive-"));
const HOME = path.join(TMP, "home");          // the app dir: maurice.db, images/ …
const DATA = path.join(HOME, "data");         // the data-api dir, as on the Mac
const GARDENS = path.join(TMP, "elsewhere", "notgardens"); // renamed on the way in
const OUT = path.join(TMP, "out");

function write(file: string, text = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeAll(() => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const db = new Database(path.join(HOME, "maurice.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE households (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO households VALUES ('default', 'Famille Tanaka-Lefèvre');
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, role TEXT,
                        created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO users (id, username, display_name, role) VALUES
      ('u1', 'theo', 'Théo', 'admin'), ('u2', 'mei', 'Mei', 'standard');
    CREATE TABLE mail_accounts (id TEXT PRIMARY KEY, member_id TEXT, secret TEXT NOT NULL,
                                state TEXT NOT NULL DEFAULT 'ok', last_error TEXT);
    INSERT INTO mail_accounts (id, member_id, secret) VALUES ('a1', 'u2', 'v1:SEALED-PASSWORD');
    ALTER TABLE users ADD COLUMN pin_hash TEXT;
    ALTER TABLE users ADD COLUMN cloudflare_token TEXT;
    UPDATE users SET pin_hash = 'PIN-HASH', cloudflare_token = 'CF-TOKEN' WHERE id = 'u2';
    ALTER TABLE households ADD COLUMN scaleway_api_key TEXT;
    UPDATE households SET scaleway_api_key = 'SCW-OPERATOR-KEY';
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
    INSERT INTO sessions VALUES ('LIVE-SESSION-TOKEN', 'u2');
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, token_plain TEXT);
    INSERT INTO api_tokens VALUES ('t1', 'u2', 'h', 'maur_PLAIN-TOKEN');
    PRAGMA user_version = 7;
  `);
  db.close();

  const life = new Database(path.join(DATA, "life.db"));
  life.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO tasks (title) VALUES ('water the plants');`);
  life.close();
  write(path.join(DATA, "signals.db"), "");        // an empty placeholder, as on the Mac
  write(path.join(DATA, "qdrant", "dead.bin"));    // never travels

  fs.mkdirSync(path.join(HOME, "mail"), { recursive: true });
  const mail = new Database(path.join(HOME, "mail", "u1.db"));
  mail.exec(`PRAGMA journal_mode = WAL; CREATE TABLE messages (id TEXT PRIMARY KEY); INSERT INTO messages VALUES ('m1');`);
  mail.close();

  write(path.join(HOME, "images", "theo", "a.png"), "PNG");
  write(path.join(HOME, "files", "guide.pdf"));
  write(path.join(HOME, "uploads", "u1", "photo.jpg"));
  write(path.join(HOME, "avatars", "theo-sq.png"));
  write(path.join(HOME, "config.toml"), `[general]\ntimezone = "Europe/Paris"\n\n[paths]\ndata_dir = "/Users/someone/.maurice/data"\n\n[ports]\napi = 3001\n`);
  // What must stay behind.
  write(path.join(HOME, "backups", "db", "old.db.gz"));
  write(path.join(HOME, "logs", "api.log"));
  write(path.join(HOME, "run", "api.pid"));
  write(path.join(HOME, "ops", "secret.env"), "TOKEN=nope");
  write(path.join(HOME, ".env"), "SECRET=nope");
  write(path.join(HOME, "images", ".DS_Store"));
  write(path.join(HOME, "images", "._a.png"));

  write(path.join(GARDENS, "gardens.json"), `{"theo": {"port": 4321, "base": "/g/theo"}}`);
  write(path.join(GARDENS, "theo", "notes", "en", "japan.md"), "# Japan 2023");
  write(path.join(GARDENS, "theo", ".git", "HEAD"), "ref: refs/heads/main\n");
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function listing(archive: string): string[] {
  const r = Bun.spawnSync(["tar", "-tzf", archive]);
  return r.stdout.toString().split("\n").filter(Boolean).map((n) => n.replace(/^\.\//, ""));
}

describe("household archive", () => {
  let archive = "";

  test("export: the tarball, its name and its manifest", async () => {
    const { exportHousehold } = await import("../src/services/archive");
    const { path: out, manifest } = await exportHousehold({ appDir: HOME, dataDir: DATA, gardensDir: GARDENS, outDir: OUT });
    archive = out;

    expect(path.basename(out)).toMatch(/^famille-tanaka-lefevre-\d{8}-\d{6}\.maurice\.tar\.gz$/);
    expect(manifest.format).toBe("maurice-archive");
    expect(manifest.version).toBe(1);
    expect(manifest.household).toEqual({ id: "default", name: "Famille Tanaka-Lefèvre" });
    expect(manifest.members.map((m) => m.username)).toEqual(["theo", "mei"]);
    expect(manifest.members[0]).toEqual({ id: "u1", username: "theo", display_name: "Théo", role: "admin" });
    expect(manifest.schema_version).toBe(7);
    expect(typeof manifest.server_version).toBe("string");
    expect(manifest.contents).toEqual([
      "manifest.json", "maurice.db", "data/", "mail/", "gardens/", "images/", "files/", "uploads/", "avatars/", "config.toml",
    ]);
    // The staging dir is gone once the file is written.
    expect(fs.readdirSync(OUT).filter((f) => f.startsWith("maurice-archive-"))).toEqual([]);
  });

  test("export: what travels and what stays behind", () => {
    const names = listing(archive);
    for (const wanted of [
      "manifest.json", "maurice.db", "data/life.db", "data/signals.db", "mail/u1.db",
      "gardens/gardens.json", "gardens/theo/notes/en/japan.md", "gardens/theo/.git/HEAD",
      "images/theo/a.png", "files/guide.pdf", "uploads/u1/photo.jpg", "avatars/theo-sq.png", "config.toml",
    ]) expect(names).toContain(wanted);

    for (const n of names) {
      expect(n).not.toMatch(/^(backups|logs|run|ops|\.env)/);
      expect(n).not.toMatch(/qdrant|\.db-wal$|\.db-shm$|\.DS_Store|\/\._/);
      expect(n).not.toMatch(/^notgardens/);
    }
  });

  test("export: the manifest inside matches the one returned", async () => {
    const { readArchiveManifest } = await import("../src/services/archive");
    const m = readArchiveManifest(archive);
    expect(m.household.name).toBe("Famille Tanaka-Lefèvre");
    expect(m.members).toHaveLength(2);
  });

  test("export: the streamed form is the same archive", async () => {
    const { exportHouseholdStream } = await import("../src/services/archive");
    const { stream, filename, manifest, done } = exportHouseholdStream({ appDir: HOME, dataDir: DATA, gardensDir: GARDENS, outDir: OUT });
    expect(filename).toMatch(/\.maurice\.tar\.gz$/);
    expect(manifest.members).toHaveLength(2);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    await done;
    const streamed = path.join(OUT, "streamed.tar.gz");
    fs.writeFileSync(streamed, bytes);
    expect(listing(streamed).sort()).toEqual(listing(archive).sort());
    expect(fs.readdirSync(OUT).filter((f) => f.startsWith("maurice-archive-"))).toEqual([]);
  });

  test("import: a fresh dir gets the household back, in the split layout", async () => {
    const { importHousehold } = await import("../src/services/archive");
    const into = path.join(TMP, "fresh");
    const m = await importHousehold(archive, { into });
    expect(m.household.name).toBe("Famille Tanaka-Lefèvre");

    const db = new Database(path.join(into, "maurice.db"), { readonly: true });
    expect((db.query("SELECT COUNT(*) n FROM users").get() as any).n).toBe(2);
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(7);
    // A member's mail password is not the admin's to carry: emptied, the
    // account marked to be reconnected — and not left in a freed page either.
    const acct = db.query("SELECT secret, state, last_error FROM mail_accounts").get() as any;
    expect(acct.secret).toBe("");
    expect(acct.state).toBe("error");
    expect(acct.last_error).toContain("enter the password again");
    db.close();
    expect(fs.readFileSync(path.join(into, "maurice.db")).includes("SEALED-PASSWORD")).toBe(false);
    // The live database keeps it.
    const live = new Database(path.join(HOME, "maurice.db"), { readonly: true });
    expect((live.query("SELECT secret FROM mail_accounts").get() as any).secret).toBe("v1:SEALED-PASSWORD");
    live.close();
    // The machine owner's archive moves the household as it is: sessions and
    // keys travel; a member's Cloudflare token does not.
    const bytes = fs.readFileSync(path.join(into, "maurice.db"));
    expect(bytes.includes("LIVE-SESSION-TOKEN")).toBe(true);
    expect(bytes.includes("SCW-OPERATOR-KEY")).toBe(true);
    expect(bytes.includes("CF-TOKEN")).toBe(false);
    const life = new Database(path.join(into, "data", "life.db"), { readonly: true });
    expect((life.query("SELECT title FROM tasks").get() as any).title).toBe("water the plants");
    life.close();

    const mail = new Database(path.join(into, "mail", "u1.db"), { readonly: true });
    expect((mail.query("SELECT id FROM messages").get() as any).id).toBe("m1");
    mail.close();

    expect(fs.existsSync(path.join(into, "gardens", "theo", ".git", "HEAD"))).toBe(true);
    expect(fs.existsSync(path.join(into, "images", "theo", "a.png"))).toBe(true);
    expect(fs.existsSync(path.join(into, "ops"))).toBe(false);
    // config.toml came along, repointed at this dir's data/.
    const config = fs.readFileSync(path.join(into, "config.toml"), "utf8");
    expect(config).toContain(`data_dir = "${path.join(into, "data")}"`);
    expect(config).toContain('timezone = "Europe/Paris"');
    expect(config).not.toContain("/Users/someone");
  });

  test("import: refuses a dir that already holds a household", async () => {
    const { importHousehold, ArchiveError } = await import("../src/services/archive");
    const into = path.join(TMP, "fresh"); // populated by the test above
    await expect(importHousehold(archive, { into })).rejects.toBeInstanceOf(ArchiveError);
    await expect(importHousehold(archive, { into })).rejects.toThrow(/refusing/);
  });

  test("import: refuses a manifest of another version, and a stranger's tar", async () => {
    const { importHousehold, ArchiveError } = await import("../src/services/archive");
    const bad = path.join(TMP, "bad");
    write(path.join(bad, "manifest.json"), JSON.stringify({ format: "maurice-archive", version: 2 }));
    write(path.join(bad, "maurice.db"), "");
    const v2 = path.join(OUT, "v2.maurice.tar.gz");
    Bun.spawnSync(["tar", "-czf", v2, "-C", bad, "manifest.json", "maurice.db"]);
    const into = path.join(TMP, "fresh-v2");
    await expect(importHousehold(v2, { into })).rejects.toThrow(/version 2/);
    expect(fs.existsSync(path.join(into, "maurice.db"))).toBe(false);

    const stranger = path.join(OUT, "stranger.tar.gz");
    Bun.spawnSync(["tar", "-czf", stranger, "-C", bad, "maurice.db"]);
    await expect(importHousehold(stranger, { into })).rejects.toBeInstanceOf(ArchiveError);
  });

  test("export for the admin: nothing in it opens anything", async () => {
    const { exportHousehold } = await import("../src/services/archive");
    const outDir = path.join(TMP, "admin-out");
    fs.writeFileSync(path.join(HOME, "secret.key"), "HOUSEHOLD-KEY");
    fs.mkdirSync(path.join(HOME, "mail"), { recursive: true });
    new Database(path.join(HOME, "mail", "u2.db")).close();
    const { path: out, manifest } = await exportHousehold({ appDir: HOME, dataDir: DATA, gardensDir: GARDENS, outDir, forAdmin: true });
    // The household key stays home, and with it the mail it seals.
    const listing = new TextDecoder().decode(Bun.spawnSync(["tar", "-tzf", out]).stdout);
    expect(listing).not.toContain("secret.key");
    expect(listing).not.toMatch(/(^|\/)mail\//m);
    expect(manifest.contents).not.toContain("secret.key");
    expect(manifest.contents).not.toContain("mail/");
    // The machine owner's archive keeps both.
    const owner = await exportHousehold({ appDir: HOME, dataDir: DATA, gardensDir: GARDENS, outDir: path.join(TMP, "owner-out") });
    expect(owner.manifest.contents).toContain("secret.key");
    expect(owner.manifest.contents).toContain("mail/");
    fs.rmSync(path.join(HOME, "secret.key"));
    fs.rmSync(path.join(HOME, "mail"), { recursive: true });
    const x = path.join(TMP, "admin-x");
    fs.mkdirSync(x, { recursive: true });
    Bun.spawnSync(["tar", "-xzf", out, "-C", x, "maurice.db"]);
    const bytes = fs.readFileSync(path.join(x, "maurice.db"));
    for (const secret of ["LIVE-SESSION-TOKEN", "maur_PLAIN-TOKEN", "PIN-HASH", "SCW-OPERATOR-KEY", "CF-TOKEN", "SEALED-PASSWORD"]) {
      expect(bytes.includes(secret)).toBe(false);
    }
    const db = new Database(path.join(x, "maurice.db"), { readonly: true });
    expect((db.query("SELECT COUNT(*) n FROM users").get() as any).n).toBe(2);   // the members stay
    expect((db.query("SELECT COUNT(*) n FROM api_tokens").get() as any).n).toBe(1); // the row, not the token
    db.close();
  });

  test("export: the default dirs follow MAURICE_DATA_DIR and MAURICE_GARDENS_DIR", async () => {
    // A flat install (data-api databases beside maurice.db), which is what
    // every suite and the demo seed run on.
    const flat = path.join(TMP, "flat");
    fs.mkdirSync(flat, { recursive: true });
    fs.copyFileSync(path.join(HOME, "maurice.db"), path.join(flat, "maurice.db"));
    fs.copyFileSync(path.join(DATA, "life.db"), path.join(flat, "life.db"));
    const saved = { data: process.env.MAURICE_DATA_DIR, gardens: process.env.MAURICE_GARDENS_DIR };
    process.env.MAURICE_DATA_DIR = flat;
    process.env.MAURICE_GARDENS_DIR = GARDENS;
    try {
      const { exportHousehold } = await import("../src/services/archive");
      const { path: out, manifest } = await exportHousehold({ outDir: OUT });
      expect(manifest.contents).toEqual(["manifest.json", "maurice.db", "data/", "gardens/"]);
      const names = listing(out);
      expect(names).toContain("data/life.db");
      expect(names).not.toContain("data/maurice.db");
      expect(names).toContain("gardens/gardens.json");
    } finally {
      process.env.MAURICE_DATA_DIR = saved.data;
      if (saved.gardens === undefined) delete process.env.MAURICE_GARDENS_DIR;
      else process.env.MAURICE_GARDENS_DIR = saved.gardens;
    }
  });
});
