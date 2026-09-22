/**
 * Teach Calibre-Web who Maurice's members are, and where the library is.
 *
 * Calibre-Web keeps its own configuration and its own user table in `app.db`,
 * and it authenticates a reverse-proxy header only against a user that already
 * exists (`load_user_from_reverse_proxy_header` matches on name). So a member
 * who has never been provisioned gets a login form inside an app they are
 * already signed into. This reconciles the two sides on every start.
 *
 * What it sets:
 *
 *  - `config_calibre_dir` — the library, so Calibre-Web does not open on its
 *    "show me a library" screen.
 *  - reverse-proxy header login, on, with the header the Bun proxy sends, and
 *    `127.0.0.1` as the only trusted source.
 *  - one Calibre-Web user per Maurice member, admin where Maurice says admin.
 *  - the listening port, which is configuration here and not a flag.
 *
 * **No shared secret, on purpose.** Calibre-Web can also demand a secret header,
 * which guards against a *client* forging the identity header. That threat does
 * not exist here: Calibre-Web binds loopback, exactly like the MCP gateway and
 * the Astro instances, so the only thing that can reach it is the Bun server —
 * which sets the header itself after authenticating. A secret would be a second
 * credential to store and rotate for a door that is already closed.
 *
 * Passwords are set to a random value nobody is told. The proxy is the way in;
 * a member who reached the login form would be at the wrong door anyway.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { getDataDir, getPort } from "../data-api/lib/config";
import { defaultLibraryRoot } from "./ensure-calibre-library";

/** The header the Bun proxy sets, and Calibre-Web trusts. */
export const MEMBER_HEADER = "X-Maurice-Member";

// cps/constants.py
const ROLE_ADMIN = 1 << 0;
const ROLE_UPLOAD = 1 << 2;
const ROLE_EDIT = 1 << 3;
const ROLE_DELETE_BOOKS = 1 << 7;

const ROLE_MEMBER = ROLE_UPLOAD | ROLE_EDIT;
const ROLE_OWNER = ROLE_ADMIN | ROLE_UPLOAD | ROLE_EDIT | ROLE_DELETE_BOOKS;

export function calibreWebDataDir(): string {
  return process.env.MAURICE_CALIBRE_WEB_DIR ?? path.join(getDataDir(), "calibre", "web");
}

export interface Member {
  username: string;
  isAdmin: boolean;
}

/** Maurice's members, from the engine's database. */
export function readMembers(mauriceDbPath: string): Member[] {
  const db = new Database(mauriceDbPath, { readonly: true });
  try {
    const rows = db
      .query(`SELECT username, role FROM users WHERE username IS NOT NULL`)
      .all() as Array<{ username: string; role: string | null }>;
    return rows.map((r) => ({ username: r.username, isAdmin: r.role === "admin" }));
  } finally {
    db.close();
  }
}

export interface ReconcileResult {
  libraryRoot: string;
  added: string[];
  updated: string[];
}

export function configureCalibreWeb(
  appDbPath: string,
  members: Member[],
  libraryRoot = defaultLibraryRoot(),
  // Not a command-line option: Calibre-Web reads its listening port from
  // app.db, so setting it is part of configuring it.
  port = getPort("calibre-web"),
): ReconcileResult {
  if (!existsSync(appDbPath)) {
    throw new Error(
      `Calibre-Web's app.db is not at ${appDbPath} — it is created on first start, ` +
        `so start-calibre-web.sh runs it once before calling this.`,
    );
  }

  const db = new Database(appDbPath);
  const added: string[] = [];
  const updated: string[] = [];
  try {
    db.run(
      `UPDATE settings SET
         config_calibre_dir = ?,
         config_allow_reverse_proxy_header_login = 1,
         config_reverse_proxy_login_header_name = ?,
         config_reverse_proxy_use_shared_secret = 0,
         config_reverse_proxy_trusted_ips = ?,
         config_uploading = 1,
         config_port = ?`,
      [libraryRoot, MEMBER_HEADER, "127.0.0.1,::1", port],
    );

    for (const member of members) {
      const role = member.isAdmin ? ROLE_OWNER : ROLE_MEMBER;
      const existing = db
        .query(`SELECT id FROM user WHERE LOWER(name) = LOWER(?)`)
        .get(member.username) as { id: number } | undefined;

      if (existing) {
        // Role only: never touch a user's own preferences (locale, sidebar,
        // shelves, and the Kindle address they set themselves) — they are
        // theirs, and this runs on every start.
        db.run(`UPDATE user SET role = ? WHERE id = ?`, [role, existing.id]);
        updated.push(member.username);
      } else {
        // Every column SQLAlchemy gives a default must be spelled out here: a
        // row inserted in raw SQL gets NULL where the ORM would have put "",
        // {} or 0, and Calibre-Web then dies rendering the book list on
        // `view_settings.get(...)` — a 500 with the member correctly
        // identified, which reads like an auth bug and is not one.
        db.run(
          `INSERT INTO user (
             name, email, role, password, kindle_mail, locale, sidebar_view,
             default_language, denied_tags, allowed_tags, denied_column_value,
             allowed_column_value, view_settings, kobo_only_shelves_sync
           ) VALUES (?, ?, ?, ?, '', 'fr', 1, 'all', '', '', '', '', '{}', 0)`,
          [
            member.username,
            // Calibre-Web wants an address per user; Maurice has none to give
            // (no email column), and this one is only a placeholder the member
            // replaces if they ever send a book to a Kindle.
            `${member.username}@localhost`,
            role,
            // Unusable by design: the proxy is the way in.
            `maurice-proxy-only-${crypto.randomUUID()}`,
          ],
        );
        added.push(member.username);
      }
    }
  } finally {
    db.close();
  }

  return { libraryRoot, added, updated };
}

if (import.meta.main) {
  const appDb = process.argv[2] || path.join(calibreWebDataDir(), "app.db");
  const mauriceDb =
    process.env.MAURICE_DB ?? path.join(process.env.HOME || "", ".maurice", "maurice.db");
  const members = readMembers(mauriceDb);
  const result = configureCalibreWeb(appDb, members);
  console.log(
    `[calibre-web] library ${result.libraryRoot}; ` +
      `members added: ${result.added.join(", ") || "none"}; ` +
      `updated: ${result.updated.join(", ") || "none"}`,
  );
}
