#!/usr/bin/env bun
/**
 * Hand a freshly uploaded build to every TestFlight group.
 *
 * Usage: asc-release-build.ts <build number> <platform>...   (platform: ios|macos)
 *
 * Internal groups with "access to all builds" get a build the moment Apple has
 * processed it. External groups do not: the build must be added to the group
 * and a beta review submission created. When the marketing version has already
 * been through beta review, Apple approves that submission in minutes without
 * a human looking — which is the whole point of keeping app/VERSION stable
 * between reviews. This script does those two steps, after waiting for the
 * upload to finish processing, so build-testflight.sh is one command from
 * archive to "every tester has it".
 *
 * Auth reuses the App Store Connect API key that build-testflight.sh already
 * needs, exactly like asc-build-info.ts.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const BUNDLE = process.env.IOS_BUNDLE_ID || "eu.chezmaurice.app";
const [buildNumber, ...platformArgs] = process.argv.slice(2);
const WAIT_MINUTES = Number(process.env.ASC_WAIT_MINUTES || 25);

if (!KEY_ID || !ISSUER) {
  console.error("asc-release-build: set ASC_KEY_ID and ASC_ISSUER_ID");
  process.exit(1);
}
if (!buildNumber || platformArgs.length === 0) {
  console.error("asc-release-build: usage <build number> <ios|macos>...");
  process.exit(1);
}

const keyPath =
  process.env.ASC_KEY_PATH ||
  `${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`;
const key = readFileSync(keyPath, "utf8");

const PLATFORM: Record<string, string> = { ios: "IOS", macos: "MAC_OS" };
const wanted = platformArgs.map((p) => {
  const v = PLATFORM[p];
  if (!v) {
    console.error(`asc-release-build: unknown platform '${p}'`);
    process.exit(1);
  }
  return v;
});

// A JWT lives 20 minutes at most; mint a fresh one per request so a long wait
// for processing never outlives the token.
function token(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
  const payload = b64({ iss: ISSUER, iat: now, exp: now + 900, aud: "appstoreconnect-v1" });
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return {};
  const body: any = await res.json();
  if (body.errors) {
    const e = body.errors[0];
    throw new Error(`${res.status} ${e?.title ?? ""}${e?.detail ? ": " + e.detail : ""}`);
  }
  return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait until Apple has processed the upload for this platform. A build shows up
// in the list a minute or two after the upload, in PROCESSING; VALID follows.
async function waitForBuild(appId: string, platform: string): Promise<any> {
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  let announced = false;
  for (;;) {
    const res = await api(
      `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&filter[preReleaseVersion.platform]=${platform}&include=buildBetaDetail&limit=5`,
    );
    const build = res.data?.[0];
    const state = build?.attributes?.processingState;
    if (state === "VALID") return { build, detail: res.included?.find((i: any) => i.type === "buildBetaDetails") };
    if (state === "FAILED" || state === "INVALID") throw new Error(`build ${buildNumber} (${platform}) is ${state}`);
    if (Date.now() > deadline) throw new Error(`build ${buildNumber} (${platform}) still ${state ?? "absent"} after ${WAIT_MINUTES} min`);
    if (!announced) {
      console.log(`  ${platform}: waiting for App Store Connect to process build ${buildNumber}…`);
      announced = true;
    }
    await sleep(30_000);
  }
}

try {
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`no app with bundle id ${BUNDLE}`);

  const groups = await api(`/v1/betaGroups?filter[app]=${app.id}&limit=50`);
  const external = (groups.data ?? []).filter((g: any) => !g.attributes.isInternalGroup);

  for (const platform of wanted) {
    const { build, detail } = await waitForBuild(app.id, platform);
    console.log(`  ${platform}: build ${buildNumber} processed`);

    for (const g of external) {
      await api(`/v1/betaGroups/${g.id}/relationships/builds`, {
        method: "POST",
        body: JSON.stringify({ data: [{ type: "builds", id: build.id }] }),
      });
      console.log(`  ${platform}: added to external group "${g.attributes.name}"`);
    }
    if (external.length === 0) continue;

    // One submission per build. READY_FOR_BETA_SUBMISSION means none exists yet;
    // any other external state means it was already submitted (or approved).
    const state = detail?.attributes?.externalBuildState;
    if (state === "READY_FOR_BETA_SUBMISSION") {
      const sub = await api(`/v1/betaAppReviewSubmissions`, {
        method: "POST",
        body: JSON.stringify({
          data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
        }),
      });
      console.log(`  ${platform}: beta review submitted (${sub.data?.attributes?.betaReviewState})`);
    } else {
      console.log(`  ${platform}: external state already ${state}`);
    }
  }
} catch (err) {
  console.error(`asc-release-build: ${(err as Error).message}`);
  process.exit(1);
}
