/**
 * Which build this server is — version, commit, date — resolved once.
 *
 * Its own module, free of any import of the database, because two callers
 * must be able to ask without opening maurice.db: /healthz reads it through
 * services/health.ts as before, and the household archive stamps it into
 * its manifest — including from `scripts/archive.ts`, a CLI that runs beside
 * a live server and must never open (and migrate) the live database.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export type BuildInfo = { version: string; git_sha: string | null; built_at: string | null };

const SERVER_ROOT = join(import.meta.dir, "..", "..");

function git(...args: string[]): string | null {
  try {
    const r = spawnSync("git", ["-C", SERVER_ROOT, ...args], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolved once at startup. Precedence: env → the git checkout this server
 * runs from → build-info.json → "dev".
 *
 * Git before the file, and that order matters. `scripts/build-info.sh` writes
 * build-info.json into the CHECKOUT, not into the image it is preparing, and
 * nothing removes it afterwards — so on the Mac, where the launchd service
 * runs the checkout itself, one `deploy.sh` left a stamp that outranked git
 * for every restart after it, and the fleet table reported a commit the
 * instance had stopped running days earlier. A checkout that answers
 * `git rev-parse` knows what it is running better than any file beside it.
 *
 * The file is still the answer where it was always meant to be: inside the
 * image, which ships without a .git, so git returns nothing and the stamp
 * speaks. And the three MAURICE_* variables still win over both.
 */
export function resolveBuildInfo(): BuildInfo {
  let fromFile: Partial<BuildInfo> = {};
  const file = join(SERVER_ROOT, "build-info.json");
  if (existsSync(file)) {
    try { fromFile = JSON.parse(readFileSync(file, "utf8")); } catch {}
  }
  const inGit = git("rev-parse", "--short=12", "HEAD");
  const sha = process.env.MAURICE_GIT_SHA || inGit || fromFile.git_sha;
  const version =
    process.env.MAURICE_VERSION ||
    (inGit ? git("describe", "--tags", "--match", "*v[0-9]*", "--always", "--dirty") : null) ||
    fromFile.version || "dev";
  const builtAt =
    process.env.MAURICE_BUILT_AT ||
    (inGit ? git("show", "-s", "--format=%cI", "HEAD") : null) ||
    fromFile.built_at;
  return { version, git_sha: sha ?? null, built_at: builtAt ?? null };
}

export const BUILD: BuildInfo = resolveBuildInfo();
