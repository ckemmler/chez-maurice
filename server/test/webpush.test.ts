/**
 * Web Push encryption against the worked example of RFC 8291 (§5, Appendix A):
 * same keys, same salt, same auth secret — the same bytes, or it is not the
 * standard and no relay's client will read it.
 */
import { expect, test } from "bun:test";
import { b64urlDecode, b64urlEncode, encryptWebPush, importServerKeys, isPushEndpoint, sendWebPush } from "../src/services/webpush";

const asPublic = b64urlDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
const asPrivate = b64urlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
const uaPublic = b64urlDecode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
const salt = b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw");
const auth = b64urlDecode("BTBZMqHH6r4Tts7J_aSIgg");
const plaintext = new TextEncoder().encode("When I grow up, I want to be a watermelon");

test("the RFC 8291 example, byte for byte", async () => {
  const body = await encryptWebPush(plaintext, uaPublic, auth, { salt, keys: await importServerKeys(asPrivate, asPublic) });
  expect(b64urlEncode(body.slice(0, 86))).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  expect(b64urlEncode(body.slice(86))).toBe("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ");
});

test("each message has its own salt and key", async () => {
  const a = await encryptWebPush(plaintext, uaPublic, auth);
  const b = await encryptWebPush(plaintext, uaPublic, auth);
  expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
  expect(a.length).toBe(86 + plaintext.length + 1 + 16);
});

test("sent as aes128gcm to the endpoint", async () => {
  let seen: { url: string; headers: Record<string, string>; size: number } | null = null;
  const r = await sendWebPush("https://ntfy.sh/upAbC?up=1", b64urlEncode(uaPublic), b64urlEncode(auth), { title: "t", body: "b" },
    (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, size: (init.body as Uint8Array).length };
      return new Response("", { status: 201 });
    }) as typeof fetch);
  expect(r.ok).toBe(true);
  expect(seen!.url).toBe("https://ntfy.sh/upAbC?up=1");
  expect(seen!.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(seen!.size).toBeGreaterThan(86);
});

test("endpoints are https, or http on this machine", () => {
  expect(isPushEndpoint("https://ntfy.sh/upAbC?up=1")).toBe(true);
  expect(isPushEndpoint("http://localhost:8080/up")).toBe(true);
  expect(isPushEndpoint("http://evil.example/up")).toBe(false);
  expect(isPushEndpoint("abc123")).toBe(false);
});
