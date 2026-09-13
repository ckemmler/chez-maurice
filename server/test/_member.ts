/**
 * A member for suites that need one — seeded into the throwaway maurice.db the
 * preload points at, instead of borrowed from the developer's real database
 * (which is what three suites used to do, and what tied the whole run to
 * whoever's ~/.maurice happened to be there).
 *
 * Username "candide" because articles.test.ts names its garden directory so.
 */
import db from "../src/db";

db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
db.run(
  `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`,
  ["test-member", "candide", "Test member"],
);

export const MEMBER = db
  .query(`SELECT id, username FROM users WHERE id = 'test-member'`)
  .get() as { id: string; username: string };
