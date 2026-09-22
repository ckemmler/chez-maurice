import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

// Two things stand between a fresh household and a working library: a library
// that exists at all (Calibre-Web makes none), and a Calibre-Web that knows
// who Maurice's members are (it authenticates a proxy header only against a
// user it already has). Both run on every start, so both have to be safe to
// run on every start.

const TMP = "/tmp/maurice-calibre-web-test";
process.env.MAURICE_CALIBRE_ARTIFACTS_DIR = path.join(TMP, "artifacts");
process.env.MAURICE_CALIBRE_LIBRARY = path.join(TMP, "library");

const { ensureCalibreLibrary } = await import("../scripts/ensure-calibre-library");
const { configureCalibreWeb, MEMBER_HEADER } = await import("../scripts/configure-calibre-web");

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("creating a library where there is none", () => {
  it("writes a real Calibre database, not a lookalike", () => {
    const root = path.join(TMP, "library");
    const result = ensureCalibreLibrary(root);
    expect(result.created).toBe(true);

    const db = new Database(path.join(root, "metadata.db"), { readonly: true });
    try {
      // The two markers every Calibre checks before it will open a directory.
      expect((db.query(`PRAGMA user_version`).get() as any).user_version).toBe(27);
      expect((db.query(`PRAGMA application_id`).get() as any).application_id).toBe(0x63616c69);
      // And the tables the read paths need on the other side.
      const tables = (db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>).map((t) => t.name);
      expect(tables).toContain("books");
      expect(tables).toContain("authors");
      expect(tables).toContain("data");
      // A library identifies itself; one generated up front cannot be confused
      // with another when two are synced or merged.
      expect((db.query(`SELECT COUNT(*) AS n FROM library_id`).get() as any).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("never touches a library that already exists", () => {
    const root = path.join(TMP, "library");
    ensureCalibreLibrary(root);
    const meta = path.join(root, "metadata.db");
    // Stand in for a real collection: if the second run rebuilt the schema,
    // this row would be gone. Written to `preferences` rather than `books`
    // because inserting a book fires Calibre's triggers, which call
    // `title_sort()` — a function Calibre and Calibre-Web register on their own
    // connections and bun:sqlite does not have. Which is the contract: this
    // server reads metadata.db and never writes it.
    const db = new Database(meta);
    db.run(`INSERT INTO preferences (key, val) VALUES ('maurice_test', 'déjà là')`);
    db.close();

    const again = ensureCalibreLibrary(root);
    expect(again.created).toBe(false);

    const check = new Database(meta, { readonly: true });
    const row = check.query(`SELECT val FROM preferences WHERE key = 'maurice_test'`).get() as {
      val: string;
    };
    check.close();
    expect(row.val).toBe("déjà là");
  });

  it("leaves nothing behind when the schema cannot be applied", () => {
    // The build happens beside the target and is moved into place, so a failed
    // run cannot leave a half-written metadata.db that the next run would
    // trust as "already present".
    const root = path.join(TMP, "library");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "metadata.db.new-blocked"), { recursive: true });
    ensureCalibreLibrary(root);
    const strays = fs.readdirSync(root).filter((f) => f.startsWith(".metadata.db.new-"));
    expect(strays).toEqual([]);
  });
});

/** The slice of Calibre-Web's app.db these scripts write to. */
function fakeAppDb(): string {
  const p = path.join(TMP, "app.db");
  const db = new Database(p, { create: true });
  db.exec(`
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY, config_calibre_dir TEXT, config_port INTEGER,
      config_allow_reverse_proxy_header_login BOOLEAN,
      config_reverse_proxy_login_header_name TEXT,
      config_reverse_proxy_use_shared_secret BOOLEAN,
      config_reverse_proxy_trusted_ips TEXT, config_uploading BOOLEAN
    );
    INSERT INTO settings (id) VALUES (1);
    CREATE TABLE user (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE, email TEXT, role SMALLINT,
      password TEXT, kindle_mail TEXT, locale TEXT, sidebar_view INTEGER,
      default_language TEXT, denied_tags TEXT, allowed_tags TEXT,
      denied_column_value TEXT, allowed_column_value TEXT, view_settings TEXT,
      kobo_only_shelves_sync INTEGER
    );
  `);
  db.close();
  return p;
}

describe("reconciling Maurice's members into Calibre-Web", () => {
  const members = [
    { username: "candide", isAdmin: true },
    { username: "paola", isAdmin: false },
  ];

  it("points Calibre-Web at the library and trusts only the loopback proxy", () => {
    const appDb = fakeAppDb();
    configureCalibreWeb(appDb, members, "/tmp/some/library", 8083);

    const db = new Database(appDb, { readonly: true });
    const s = db.query(`SELECT * FROM settings`).get() as any;
    db.close();

    expect(s.config_calibre_dir).toBe("/tmp/some/library");
    expect(s.config_port).toBe(8083);
    expect(s.config_allow_reverse_proxy_header_login).toBe(1);
    expect(s.config_reverse_proxy_login_header_name).toBe(MEMBER_HEADER);
    expect(s.config_reverse_proxy_trusted_ips).toBe("127.0.0.1,::1");
    // Header login without a trusted-IP restriction would let anything that
    // reaches the port claim to be anyone.
    expect(s.config_reverse_proxy_trusted_ips).not.toBe("");
  });

  it("gives every member a usable account and no usable password", () => {
    const appDb = fakeAppDb();
    const result = configureCalibreWeb(appDb, members, "/tmp/lib", 8083);
    expect(result.added.sort()).toEqual(["candide", "paola"]);

    const db = new Database(appDb, { readonly: true });
    const rows = db.query(`SELECT name, role, password, view_settings FROM user`).all() as Array<any>;
    db.close();

    const candide = rows.find((r) => r.name === "candide");
    const paola = rows.find((r) => r.name === "paola");
    // Admin in Maurice is admin here (bit 0); a member is not.
    expect(candide.role & 1).toBe(1);
    expect(paola.role & 1).toBe(0);
    // Both can upload and edit — the point of the whole feature.
    expect(paola.role & (1 << 2)).toBeTruthy();
    expect(paola.role & (1 << 3)).toBeTruthy();
    // The proxy is the way in; the login form is not.
    expect(candide.password.startsWith("maurice-proxy-only-")).toBe(true);
    // NULL here is a 500 on the book list — SQLAlchemy's defaults do not apply
    // to a row inserted in raw SQL.
    expect(paola.view_settings).toBe("{}");
  });

  it("is safe to run on every start: roles refresh, preferences survive", () => {
    const appDb = fakeAppDb();
    configureCalibreWeb(appDb, members, "/tmp/lib", 8083);

    // The member makes the app theirs.
    const db = new Database(appDb);
    db.run(`UPDATE user SET locale = 'it', kindle_mail = 'paola@kindle.com' WHERE name = 'paola'`);
    db.close();

    // …and is promoted in Maurice.
    const second = configureCalibreWeb(
      appDb,
      [
        { username: "candide", isAdmin: true },
        { username: "paola", isAdmin: true },
      ],
      "/tmp/lib",
      8083,
    );
    expect(second.added).toEqual([]);
    expect(second.updated.sort()).toEqual(["candide", "paola"]);

    const check = new Database(appDb, { readonly: true });
    const paola = check.query(`SELECT * FROM user WHERE name = 'paola'`).get() as any;
    check.close();
    expect(paola.role & 1).toBe(1);
    expect(paola.locale).toBe("it");
    expect(paola.kindle_mail).toBe("paola@kindle.com");
  });

  it("says where to look when app.db is not there yet", () => {
    expect(() => configureCalibreWeb(path.join(TMP, "nope.db"), members)).toThrow(/app\.db/);
  });
});
