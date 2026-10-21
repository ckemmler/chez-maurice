// Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm of RFC 8188):
// how the Android app is reached when it is closed. The app registers through
// UnifiedPush — a distributor app on the phone (ntfy) hands it an endpoint URL
// and the keys of a Web Push subscription; the server encrypts each payload to
// those keys and POSTs it to the endpoint. The relay sees that a message passed,
// never what it says. No Google, no Firebase.

const te = new TextEncoder();

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** The application server's key pair for one message: fresh each time, or given (tests). */
export interface ServerKeys { privateKey: CryptoKey; publicRaw: Uint8Array }

async function freshKeys(): Promise<ServerKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** A key pair from its raw parts (the RFC's test vector). */
export async function importServerKeys(privateD: Uint8Array, publicRaw: Uint8Array): Promise<ServerKeys> {
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    d: b64urlEncode(privateD), x: b64urlEncode(publicRaw.slice(1, 33)), y: b64urlEncode(publicRaw.slice(33, 65)),
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey, publicRaw };
}

/**
 * Encrypt `plaintext` for a subscription (`uaPublic` = p256dh, 65 bytes
 * uncompressed; `authSecret` = 16 bytes): the aes128gcm body, header included,
 * in one record of 4096.
 */
export async function encryptWebPush(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: { salt?: Uint8Array; keys?: ServerKeys } = {},
): Promise<Uint8Array> {
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keys = opts.keys ?? (await freshKeys());
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, keys.privateKey, 256));

  // RFC 8291 §3.3–3.4: combine the ECDH secret with the auth secret, then derive key and nonce.
  const prkKey = await hmac(authSecret, ecdh);
  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, keys.publicRaw);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  // RFC 8188: one record, its padding delimiter 0x02 (last record).
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([keys.publicRaw.length]), keys.publicRaw);
  return concat(header, sealed);
}

export interface WebPushResult { ok: boolean; status: number; reason?: string }

/**
 * POST an encrypted payload to a subscription's endpoint. A 404 or 410 means
 * the subscription is gone (the app was uninstalled, the distributor reset):
 * the caller prunes it, as it does a dead Apple token.
 */
export async function sendWebPush(
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<WebPushResult> {
  const body = await encryptWebPush(te.encode(JSON.stringify(payload)), b64urlDecode(p256dh), b64urlDecode(auth));
  const res = await fetcher(endpoint, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" },
    body,
  });
  return { ok: res.ok, status: res.status, reason: res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 200) };
}

/** A UnifiedPush endpoint is an https URL; plain http only for a relay on this machine. */
export function isPushEndpoint(token: string): boolean {
  try {
    const u = new URL(token);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}
