/**
 * /healthz has two faces and the health token opens only one door: the full
 * picture, never the member's account. The error ring counts and forgets.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { MEMBER } from "./_member";
import { createApiToken, validateApiTokenRaw, validateHealthToken } from "../src/middleware/auth";
import { _resetErrors, fullHealth, publicHealth, recordError, resolveBuildInfo } from "../src/services/health";
import db, { SCHEMA_VERSION } from "../src/db";

describe("health token scope", () => {
  test("a health token reads /healthz but never authenticates as the member", async () => {
    const { rawToken } = await createApiToken(MEMBER.id, "probe", "health");
    expect(await validateHealthToken(rawToken)).toBe(true);
    expect(await validateApiTokenRaw(rawToken)).toBeNull();
  });

  test("a full token does both; an mcp token does not read health", async () => {
    const full = await createApiToken(MEMBER.id, "full", "full");
    expect(await validateHealthToken(full.rawToken)).toBe(true);
    expect((await validateApiTokenRaw(full.rawToken))?.userId).toBe(MEMBER.id);
    const mcp = await createApiToken(MEMBER.id, "mcp", "mcp");
    expect(await validateHealthToken(mcp.rawToken)).toBe(false);
  });

  test("garbage is refused", async () => {
    expect(await validateHealthToken("maur_nope")).toBe(false);
    expect(await validateHealthToken("not-a-token")).toBe(false);
  });
});

describe("health snapshots", () => {
  beforeEach(() => _resetErrors());

  test("the public face carries no more than status and version", () => {
    expect(Object.keys(publicHealth()).sort()).toEqual(["service", "status", "version"]);
  });

  test("the full face reports build, schema, db and the error rate", () => {
    recordError("[claude]");
    recordError("[claude]");
    recordError("http-500");
    const h = fullHealth();
    expect(h.status).toBe("ok");
    expect(h.db).toBe("ok");
    expect(h.schema_version).toBe(SCHEMA_VERSION);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(h.errors_1h).toBe(3);
    expect(h.errors_24h).toBe(3);
    expect(h.last_error_kind).toBe("http-500");
    expect(h.error_kinds).toEqual({ "[claude]": 2, "http-500": 1 });
    expect(typeof h.uptime_s).toBe("number");
    expect(typeof h.version).toBe("string");
  });

  test("no member data leaks into the full face", () => {
    const text = JSON.stringify(fullHealth());
    expect(text).not.toContain(MEMBER.username);
    expect(text).not.toContain(MEMBER.id);
  });
});

describe("what version the server claims to be", () => {
  const stamp = join(import.meta.dir, "..", "build-info.json");
  const STALE = { version: "20200101-000000", git_sha: "0000deadbeef", built_at: "2020-01-01T00:00:00Z" };

  /** Run `body` with a stale stamp in place; whatever was there is restored. */
  function withStaleStamp(body: () => void) {
    const had = existsSync(stamp) ? readFileSync(stamp, "utf8") : null;
    try {
      writeFileSync(stamp, JSON.stringify(STALE));
      body();
    } finally {
      if (had === null) rmSync(stamp, { force: true });
      else writeFileSync(stamp, had);
    }
  }

  test("a git checkout outranks a stamp a deploy left behind", () => {
    // build-info.sh writes into the checkout, not the image, and nothing
    // removes it — so on the Mac install the stamp would otherwise freeze the
    // reported version at whatever image was last built here.
    withStaleStamp(() => {
      const info = resolveBuildInfo();
      expect(info.git_sha).not.toBe(STALE.git_sha);
      expect(info.version).not.toBe(STALE.version);
      expect(info.git_sha).toBe(
        spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      );
    });
  });

  test("the env still wins over both, which is how an image pins itself", () => {
    withStaleStamp(() => {
      process.env.MAURICE_VERSION = "from-env";
      process.env.MAURICE_GIT_SHA = "abcabcabcabc";
      try {
        const info = resolveBuildInfo();
        expect(info.version).toBe("from-env");
        expect(info.git_sha).toBe("abcabcabcabc");
      } finally {
        delete process.env.MAURICE_VERSION;
        delete process.env.MAURICE_GIT_SHA;
      }
    });
  });
});
