/**
 * Where a build of the web engine lands. `web/dist` is the running garden
 * engine: its node server imports route modules from there as pages are first
 * asked for, so a publication built over it (8 October 2026) left every garden
 * page answering 500 until the engine was rebuilt. A publication goes to a
 * folder of its own, and the publish script deploys that folder.
 *
 * The config is loaded, not built: it needs web/node_modules, and says so and
 * skips where that is missing.
 * Run with `bun test`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dir, "../..");
const WEB = path.join(REPO, "web");
const canLoad = fs.existsSync(path.join(WEB, "node_modules", "astro"));
if (!canLoad) console.warn("[publish-outdir] web/node_modules missing — the config test is SKIPPED, not passed");

/** The `outDir` the engine's config answers under this environment. */
function outDir(vars: Record<string, string>): string {
  const { WEB_SSR: _s, GARDEN: _g, PUBLIC_STATIC: _p, ...env } = process.env;
  const res = spawnSync(process.execPath, ["-e", "console.log((await import('./astro.config.mjs')).default.outDir)"], {
    cwd: WEB,
    env: { ...env, ...vars },
    encoding: "utf-8",
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return path.normalize(res.stdout.trim());
}

describe("where a build lands", () => {
  test.skipIf(!canLoad)("only the engine's build writes web/dist", () => {
    expect(outDir({ WEB_SSR: "1", GARDEN: "anna" })).toBe("dist");
    expect(outDir({ GARDEN: "anna" })).toBe(path.join("dist-site", "anna"));
    expect(outDir({ GARDEN: "anna", PUBLIC_STATIC: "1" })).toBe(path.join("dist-site", "anna"));
    expect(outDir({})).toBe(path.join("dist-site", "demo"));
  });

  test("the publish script builds and deploys a folder of its own", () => {
    const script = fs.readFileSync(path.join(REPO, "scripts", "publish-web.sh"), "utf-8");
    expect(script).toContain('OUT="dist-site/$GARDEN"');
    expect(script).toContain('npm run build -- --outDir "$OUT"');
    expect(script).toContain('wrangler pages deploy "$OUT"');
    expect(script).not.toMatch(/pages deploy dist\b/);
  });
});
