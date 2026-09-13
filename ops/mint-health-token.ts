#!/usr/bin/env bun
/**
 * Mint a "Health only" API token straight into an instance's maurice.db —
 * for the operator who has the file but not that household's admin password.
 *
 *   ops/mint-health-token.ts <path/to/maurice.db> [label]
 *
 * Prints the raw token once; it is stored hashed, like the admin UI does.
 * Same row shape as createApiToken in server/src/middleware/auth.ts, but
 * self-contained (bun:sqlite + crypto) so it also runs inside the container
 * image with `docker exec`. Idempotent per label: an existing token with the
 * same label is replaced.
 */
import { Database } from "bun:sqlite";

const [dbPath, label = "fleet-probe"] = process.argv.slice(2);
if (!dbPath) {
  console.error("usage: mint-health-token.ts <maurice.db> [label]");
  process.exit(2);
}

const db = new Database(dbPath);
const admin = db
  .query(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)
  .get() as { id: string } | undefined;
if (!admin) {
  console.error("no admin in this database yet — set the household up first");
  process.exit(1);
}

const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
const raw = `maur_${Buffer.from(bytes).toString("base64url")}`;
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");

db.run(`DELETE FROM api_tokens WHERE user_id = ? AND label = ? AND scope = 'health'`, [admin.id, label]);
db.run(
  `INSERT INTO api_tokens (id, user_id, token_hash, label, scope) VALUES (?, ?, ?, ?, 'health')`,
  [crypto.randomUUID(), admin.id, hash, label],
);
console.log(raw);
