#!/usr/bin/env bun
/**
 * Ask App Store Connect what has already been uploaded.
 *
 * Prints one line: `<highest build number> <highest marketing version>`.
 *
 * build-testflight.sh uses it to pick the next build number, instead of deriving
 * one locally. Every local scheme is wrong sooner or later: the commit count —
 * what this script used to use — silently went from 316 in June to 128 in
 * September when the repository history was rewritten for the public release,
 * and a branch switch moves it too. Apple is the only party that knows what has
 * actually been uploaded, and it is the party that enforces the rule.
 *
 * Auth reuses the App Store Connect API key that build-testflight.sh already
 * needs, so this adds no new secret.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const BUNDLE = process.env.IOS_BUNDLE_ID || "eu.chezmaurice.app";

if (!KEY_ID || !ISSUER) {
  console.error("asc-build-info: set ASC_KEY_ID and ASC_ISSUER_ID");
  process.exit(1);
}

const keyPath =
  process.env.ASC_KEY_PATH ||
  `${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`;

let key: string;
try {
  key = readFileSync(keyPath, "utf8");
} catch {
  console.error(`asc-build-info: no API key at ${keyPath}`);
  process.exit(1);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
const payload = b64({ iss: ISSUER, iat: now, exp: now + 900, aud: "appstoreconnect-v1" });
const signer = createSign("SHA256");
signer.update(`${header}.${payload}`);
signer.end();
// ieee-p1363, not DER: JOSE wants the raw r‖s pair, and node defaults to DER.
const jwt = `${header}.${payload}.${signer
  .sign({ key, dsaEncoding: "ieee-p1363" })
  .toString("base64url")}`;

async function api(path: string): Promise<any> {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = await res.json();
  if ((body as any).errors) {
    throw new Error(`${res.status} ${JSON.stringify((body as any).errors[0]?.title ?? body)}`);
  }
  return body;
}

try {
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`no app with bundle id ${BUNDLE}`);

  // Sorted by version descending would be lexicographic ("99" > "128"), so pull
  // a page and compare numerically here.
  const builds = await api(`/v1/builds?filter[app]=${app.id}&limit=200&sort=-uploadedDate`);
  let maxBuild = 0;
  let maxVersion = "0.0.0";
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  };
  for (const b of builds.data ?? []) {
    const n = Number(b.attributes?.version);
    if (Number.isFinite(n) && n > maxBuild) maxBuild = n;
  }
  // The marketing version lives on the build's preReleaseVersion. Only builds
  // that are still valid count: a version whose every build has expired is not
  // a floor anyone can trip over any more. (A 1.1.0 uploaded by mistake would
  // otherwise demand ALLOW_VERSION_DOWNGRADE on every 1.0.0 for ninety days.)
  const withVersion = await api(
    `/v1/builds?filter[app]=${app.id}&filter[expired]=false&limit=200&include=preReleaseVersion&fields[preReleaseVersions]=version`,
  );
  for (const v of withVersion.included ?? []) {
    const s = v.attributes?.version;
    if (typeof s === "string" && cmp(s, maxVersion) > 0) maxVersion = s;
  }
  console.log(`${maxBuild} ${maxVersion}`);
} catch (err) {
  console.error(`asc-build-info: ${(err as Error).message}`);
  process.exit(1);
}
