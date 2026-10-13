// APNs sender (token-based / .p8 auth, HTTP/2). Bun's fetch can't speak APNs's
// HTTP/2-only protocol, so we use node:http2 directly. The provider JWT (ES256,
// signed with the .p8 EC key) is cached and reused for up to ~50 min.

import { connect } from "node:http2";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECRETS_DIR = join(import.meta.dir, "../../.secrets");
const TOPIC = process.env.APNS_TOPIC || "eu.chezmaurice.maurice";
// Carnet is a second app: its tokens belong to its own bundle id, and APNs
// answers DeviceTokenNotForTopic when the topic is wrong.
const CARNET_TOPIC = process.env.APNS_CARNET_TOPIC || "eu.chezmaurice.carnet";

// The Maurice app has moved to the company's developer team and Carnet has not
// yet, and an APNs key signs for one team only: until Carnet follows, each app
// has its own provider (team, key id, key file). The Maurice key id has no
// default — the key is made on the new team and named with APNS_KEY_ID. Once
// Carnet is on the same team, one provider serves both again.
interface Provider { teamId: string; keyId: string; keyPath?: string }
const MAURICE: Provider = {
  teamId: process.env.APNS_TEAM_ID || "F5B4ZC8LEU",
  keyId: process.env.APNS_KEY_ID || "",
  keyPath: process.env.APNS_KEY_PATH,
};
const CARNET: Provider = {
  teamId: process.env.APNS_CARNET_TEAM_ID || "33DB976938",
  keyId: process.env.APNS_CARNET_KEY_ID || "64JJ6Y74J7",
  keyPath: process.env.APNS_CARNET_KEY_PATH,
};

function isCarnet(platform: string | null | undefined): boolean {
  return (platform ?? "").startsWith("carnet");
}

/** The APNs topic for a device token, from the platform the client registered
 *  it with (`carnet-ios` → Carnet's bundle id; anything else → the Maurice app). */
export function apnsTopicFor(platform: string | null | undefined): string {
  return isCarnet(platform) ? CARNET_TOPIC : TOPIC;
}
// Dev/sandbox by default (matches the app's `aps-environment: development`).
// Set APNS_PRODUCTION=1 for App Store / TestFlight builds.
const HOST = process.env.APNS_PRODUCTION === "1"
  ? "https://api.push.apple.com"
  : "https://api.sandbox.push.apple.com";

/** The provider's key: the file it names, else `AuthKey_<key id>.p8` in the
 *  secrets directory. */
function loadKeyPem(p: Provider): string | null {
  try {
    const path = p.keyPath || (p.keyId ? join(SECRETS_DIR, `AuthKey_${p.keyId}.p8`) : "");
    return path ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function apnsConfigured(): boolean {
  return loadKeyPem(MAURICE) !== null || loadKeyPem(CARNET) !== null;
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

const cached = new Map<Provider, { jwt: string; at: number }>();
const signingKeys = new Map<Provider, CryptoKey>();

async function providerToken(p: Provider): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const hit = cached.get(p);
  if (hit && now - hit.at < 3000) return hit.jwt; // APNs allows reuse < 60 min
  const pem = loadKeyPem(p);
  if (!pem) return null;
  let signingKey = signingKeys.get(p);
  if (!signingKey) {
    signingKey = await crypto.subtle.importKey(
      "pkcs8", pemToDer(pem) as any, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    signingKeys.set(p, signingKey);
  }
  const input = `${b64urlStr(JSON.stringify({ alg: "ES256", kid: p.keyId }))}.${b64urlStr(JSON.stringify({ iss: p.teamId, iat: now }))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(input));
  const jwt = `${input}.${b64url(new Uint8Array(sig))}`;
  cached.set(p, { jwt, at: now });
  return jwt;
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
  payload: { title: string; body: string; conversationId?: string; householdTag?: string; platform?: string },
): Promise<ApnsResult> {
  const jwt = await providerToken(isCarnet(payload.platform) ? CARNET : MAURICE);
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
      "apns-topic": apnsTopicFor(payload.platform),
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
