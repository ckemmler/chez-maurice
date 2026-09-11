#!/usr/bin/env bun
/**
 * Give an existing member a garden.
 *
 * `createUser` (server/src/services/users.ts) creates a row in maurice.db and
 * stops there. It does not create the member's garden directory, and it does not
 * add them to gardens.json — which nothing in the repo writes: the manifest is
 * read by server/index.ts, start-garden.sh and start-all.sh, and maintained by
 * hand. So on a fresh install a member exists, can log in, and has no garden:
 * /g/<them> answers "Garden not available" and nothing explains why.
 *
 * This is the missing half. Idempotent — run it as often as you like.
 *
 *   bun run scripts/provision-member.ts <username> [--locale en] [--port 4325]
 *
 * Inside the container:
 *
 *   scripts/container.sh shell
 *   bun run /app/scripts/provision-member.ts <username>
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gardensRoot } from "../server/src/services/gardensRoot";
import { getMauriceDbPath } from "../server/lib/appDir";

interface GardenEntry {
  port?: number;
  base: string;
  title: string;
  name: string;
  avatar: string | null;
}

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!username) {
  console.error("usage: bun run scripts/provision-member.ts <username> [--locale en] [--port N]");
  process.exit(1);
}

const locale = flag("locale") ?? "en";

// ── The member must exist ────────────────────────────────────────────────────
// Checked, not assumed: a typo would otherwise create a garden nobody can reach,
// and the mistake would only surface as an empty page much later.

const dbPath = getMauriceDbPath();
if (!existsSync(dbPath)) {
  console.error(`✗ no database at ${dbPath}. Is MAURICE_DATA_DIR right?`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const user = db
  .query("SELECT username, display_name FROM users WHERE username = ?")
  .get(username) as { username: string; display_name: string } | undefined;
db.close();

if (!user) {
  console.error(`✗ no member named "${username}" in ${dbPath}.`);
  console.error("  Create them first at /admin/users/new, then run this again.");
  process.exit(1);
}

// ── The manifest ─────────────────────────────────────────────────────────────

const root = gardensRoot();
const manifestPath = join(root, "gardens.json");
const manifest: Record<string, GardenEntry> = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : {};

// One Astro process per garden, each on its own port, because Astro keys its
// dev content store to the project root and instances sharing one root
// cross-contaminate. 4321 belongs to the default garden (start-web.sh), so
// members start at 4322.
function nextFreePort(): number {
  const taken = new Set(
    Object.values(manifest)
      .map((g) => g.port)
      .filter((p): p is number => typeof p === "number"),
  );
  taken.add(4321);
  let port = 4322;
  while (taken.has(port)) port++;
  return port;
}

const existing = manifest[username];
const port = Number(flag("port")) || existing?.port || nextFreePort();

// The avatar is served by the API from the data dir, not from the garden, so it
// is only claimed here if the file is actually there — a broken image is worse
// than none.
const avatarFile = join(process.env.HOME || "", ".maurice", "avatars", `${username}-sq.png`);
const avatar = existsSync(avatarFile) ? `/api/avatars/${username}-sq.png` : null;

manifest[username] = {
  port,
  base: `/g/${username}`,
  title: `${user.display_name}'s garden`,
  name: user.display_name,
  avatar,
  ...(existing ?? {}),
  // Re-asserted after the spread: these are derived, and a stale port or base
  // from an earlier run should not win over what we just resolved.
  port,
  base: `/g/${username}`,
};

mkdirSync(root, { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ── The garden itself ────────────────────────────────────────────────────────
// Only the skeleton. The first note is the member's to write — or Maurice's,
// through the garden tool, which is the more likely and the nicer of the two.

const notesDir = join(root, username, "notes", locale);
const created = !existsSync(notesDir);
mkdirSync(notesDir, { recursive: true });
mkdirSync(join(root, username, "images"), { recursive: true });

console.log(`✓ ${username} (${user.display_name})`);
console.log(`  garden   ${join(root, username)}${created ? "  (created)" : "  (already there)"}`);
console.log(`  manifest ${manifestPath}  → port ${port}, base /g/${username}`);
console.log();
console.log("  Restart so the engine picks it up:");
console.log("    scripts/container.sh restart      (container)");
console.log("    scripts/service.sh restart        (macOS)");
