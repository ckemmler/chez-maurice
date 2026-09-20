#!/usr/bin/env bun
/**
 * Pull TestFlight feedback from App Store Connect: crash submissions (with the
 * crash log saved as a file) and screenshot submissions (images saved), newest
 * first. What a tester sends from the TestFlight sheet lands here.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… OUT=/tmp bun asc-feedback.ts [bundle id]
 *
 * The key must be allowed to read TestFlight (the App Manager key works; the
 * upload-only key answers 403).
 */
import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const KEY_ID = process.env.ASC_KEY_ID!, ISSUER = process.env.ASC_ISSUER_ID!;
const key = readFileSync(`${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`, "utf8");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const h = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" }), p = b64({ iss: ISSUER, iat: now, exp: now + 900, aud: "appstoreconnect-v1" });
const s = createSign("SHA256"); s.update(`${h}.${p}`); s.end();
const jwt = `${h}.${p}.${s.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
async function api(path: string) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(`${r.status} ${path} ${typeof b === "string" ? b.slice(0,300) : JSON.stringify(b.errors?.[0] ?? b).slice(0,400)}`);
  return b;
}
const bundle = process.argv[2] || "eu.chezmaurice.app";
const app = (await api(`/v1/apps?filter[bundleId]=${bundle}`)).data?.[0];
console.log("app", app?.id, app?.attributes?.name);
for (const kind of ["betaFeedbackCrashSubmissions", "betaFeedbackScreenshotSubmissions"]) {
  try {
    const r = await api(`/v1/apps/${app.id}/${kind}?limit=20&sort=-createdDate&include=build,tester`);
    console.log(`\n== ${kind}: ${r.data.length}`);
    for (const d of r.data) {
      const a = d.attributes;
      console.log(JSON.stringify({ id: d.id, ...a }, null, 0).slice(0, 1500));
      console.log("included:", JSON.stringify((r.included ?? []).map((i: any) => ({ type: i.type, id: i.id, v: i.attributes?.version, n: i.attributes?.email ?? i.attributes?.firstName }))));
      // try crash log
      if (kind === "betaFeedbackCrashSubmissions") {
        try {
          const cl = await api(`/v1/betaFeedbackCrashSubmissions/${d.id}/crashLog`);
          const url = cl.data?.attributes?.url; console.log("crashLog url:", url ? "yes" : cl);
          if (url) { const txt = await (await fetch(url)).text(); writeFileSync(`${process.env.OUT}/crash-${d.id}.txt`, txt); console.log("saved", txt.length, "bytes"); }
        } catch (e) { console.log("crashLog:", String(e).slice(0, 300)); }
      } else {
        for (const im of a.screenshots ?? []) { try { const bin = await (await fetch(im.url)).arrayBuffer(); const f = `${process.env.OUT}/shot-${d.id}-${im.fileName ?? "png"}`; writeFileSync(f, Buffer.from(bin)); console.log("saved", f); } catch (e) { console.log("shot:", String(e).slice(0,200)); } }
      }
    }
  } catch (e) { console.log(`${kind}:`, String(e).slice(0, 400)); }
}
