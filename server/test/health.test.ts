/**
 * /healthz has two faces and the health token opens only one door: the full
 * picture, never the member's account. The error ring counts and forgets.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { MEMBER } from "./_member";
import { createApiToken, validateApiTokenRaw, validateHealthToken } from "../src/middleware/auth";
import { _resetErrors, fullHealth, publicHealth, recordError } from "../src/services/health";
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
