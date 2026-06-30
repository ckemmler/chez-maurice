// APNs sender (token-based / .p8 auth, HTTP/2). Bun's fetch can't speak APNs's
// HTTP/2-only protocol, so we use node:http2 directly. The provider JWT (ES256,
// signed with the .p8 EC key) is cached and reused for up to ~50 min.

import { connect } from "node:http2";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SECRETS_DIR = join(import.meta.dir, "../../.secrets");
const KEY_ID = process.env.APNS_KEY_ID || "64JJ6Y74J7";
const TEAM_ID = process.env.APNS_TEAM_ID || "33DB976938";
const TOPIC = process.env.APNS_TOPIC || "eu.chezmaurice.app";
// Dev/sandbox by default (matches the app's `aps-environment: development`).
// Set APNS_PRODUCTION=1 for App Store / TestFlight builds.
const HOST = process.env.APNS_PRODUCTION === "1"
  ? "https://api.push.apple.com"
  : "https://api.sandbox.push.apple.com";

function loadKeyPem(): string | null {
  try {
    const explicit = process.env.APNS_KEY_PATH;
    const path = explicit || (() => {
      const f = readdirSync(SECRETS_DIR).find((n) => n.endsWith(".p8"));
      return f ? join(SECRETS_DIR, f) : "";
    })();
    return path ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function apnsConfigured(): boolean {
  return loadKeyPem() !== null;
}

// ── Provider JWT (ES256) ────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(body, "base64"));
}

let cachedJwt = "";
let cachedAt = 0;
let signingKey: CryptoKey | null = null;

async function providerToken(): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedAt < 3000) return cachedJwt; // APNs allows reuse < 60 min
  const pem = loadKeyPem();
  if (!pem) return null;
  if (!signingKey) {
    signingKey = await crypto.subtle.importKey(
      "pkcs8", pemToDer(pem) as any, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
  }
  const input = `${b64urlStr(JSON.stringify({ alg: "ES256", kid: KEY_ID }))}.${b64urlStr(JSON.stringify({ iss: TEAM_ID, iat: now }))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(input));
  cachedJwt = `${input}.${b64url(new Uint8Array(sig))}`;
  cachedAt = now;
  return cachedJwt;
}

// ── Send ────────────────────────────────────────────────────────

export interface ApnsResult {
  ok: boolean;
  status: number;
  reason?: string;
}

/** Send one alert push to a device token. Returns Apple's status + reason
 *  (e.g. "BadDeviceToken", "Unregistered") so the caller can prune dead tokens. */
export async function sendApns(
  deviceToken: string,
  payload: { title: string; body: string; conversationId?: string; householdTag?: string },
): Promise<ApnsResult> {
  const jwt = await providerToken();
  if (!jwt) return { ok: false, status: 0, reason: "NoProviderKey" };

  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
    ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
    ...(payload.householdTag ? { householdTag: payload.householdTag } : {}),
  });

  return new Promise<ApnsResult>((resolve) => {
    let settled = false;
    const done = (r: ApnsResult) => { if (!settled) { settled = true; resolve(r); } };
    const client = connect(HOST);
    client.on("error", (e: any) => { done({ ok: false, status: 0, reason: String(e?.message || e) }); try { client.close(); } catch {} });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    let status = 0;
    let data = "";
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      let reason: string | undefined;
      try { reason = data ? JSON.parse(data).reason : undefined; } catch {}
      try { client.close(); } catch {}
      done({ ok: status === 200, status, reason });
    });
    req.on("error", (e: any) => done({ ok: false, status: 0, reason: String(e?.message || e) }));
    req.end(body);
  });
}
