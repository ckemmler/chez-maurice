/**
 * Maurice's documentation (the maurice_docs tool) refreshes itself from the published set
 * (services/mauriceDocsRefresh.ts). A local Bun.serve stands in for the repo:
 * the first check brings the set down, a manifest already seen writes
 * nothing, a note whose hash does not match leaves the previous set intact,
 * a note that left the manifest goes, and docsDir() reads the refreshed set
 * once it is newer than the bundle.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Every suite shares one process: maurice-docs-tool.test.ts pins MAURICE_DOCS_DIR,
// which would win over any refreshed set. Step out of it for this suite only.
const savedDocsDir = process.env.MAURICE_DOCS_DIR;
delete process.env.MAURICE_DOCS_DIR;
// The SSRF guard refuses 127.0.0.1 by design; this is the door it leaves.
process.env.MAURICE_DOCS_ALLOW_LOCAL = "1";

const { refreshDocs, refreshedDocsDir, bundledDocsDir, docsStatus, docsUrl, readManifest } =
  await import("../src/services/mauriceDocsRefresh");
const { docsDir, loadMauriceDocs, docsUpdatedAt } = await import("../src/services/mauriceDocs");

// ── A fake publication channel ──────────────────────────────────

const served = new Map<string, string>();
const hits: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    hits.push(name);
    const body = served.get(name);
    return body === undefined ? new Response("no such note", { status: 404 }) : new Response(body);
  },
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const note = (title: string, date: string, body: string) =>
  `---\ntitle: ${title}\ndate: '${date}'\nparent: maurice-docs\n---\n\n${body}\n`;

/** Put a set of notes and its manifest on the fake channel. `tamper` names a
 *  note whose manifest hash is wrong. */
function publish(generatedAt: string, notes: Record<string, string>, tamper?: string): void {
  served.clear();
  const entries = Object.entries(notes).map(([file, body]) => {
    served.set(file, body);
    return {
      file,
      slug: file.replace(/\.md$/, ""),
      date: body.match(/^date: '([^']+)'/m)?.[1] ?? null,
      bytes: Buffer.byteLength(body),
      sha256: file === tamper ? sha256(body + "x") : sha256(body),
    };
  });
  served.set("manifest.json", JSON.stringify({ format: "maurice-docs", version: 1, generated_at: generatedAt, notes: entries }));
}

// Newer than whatever the bundle says today, so the first refresh is a refresh.
const bundledAt = Date.parse(readManifest(bundledDocsDir())?.generated_at ?? "2026-01-01T00:00:00Z");
const at = (hours: number) => new Date(bundledAt + hours * 3_600_000).toISOString();

const INDEX = "maurice-docs.md";
const CHAT = "maurice-chat.md";
const LIFE = "maurice-life.md";
const v1: Record<string, string> = {
  [INDEX]: `---\ntitle: Maurice — system documentation\ndate: '2027-01-02'\nparent: maurice\n---\n\n# Index\n`,
  [CHAT]: note("The chat experience", "2027-01-03", "Streaming answers."),
  [LIFE]: note("Life", "2027-01-01", "Signals and coaching."),
};

const target = refreshedDocsDir();
const read = (file: string) => fs.readFileSync(path.join(target, file), "utf8");
const mtimes = () =>
  Object.fromEntries(fs.readdirSync(target).map((f) => [f, fs.statSync(path.join(target, f)).mtimeMs]));

beforeAll(() => {
  process.env.MAURICE_DOCS_URL = `http://127.0.0.1:${server.port}`;
  fs.rmSync(target, { recursive: true, force: true });
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(target, { recursive: true, force: true });
  delete process.env.MAURICE_DOCS_URL;
  delete process.env.MAURICE_DOCS_ALLOW_LOCAL;
  if (savedDocsDir !== undefined) process.env.MAURICE_DOCS_DIR = savedDocsDir;
});

test("off by default in the test suite, and on MAURICE_DOCS_URL=off", async () => {
  const url = process.env.MAURICE_DOCS_URL;
  delete process.env.MAURICE_DOCS_URL;
  expect(docsUrl()).toBeNull();
  process.env.MAURICE_DOCS_URL = "off";
  expect(docsUrl()).toBeNull();
  expect(await refreshDocs()).toBe("off");
  process.env.MAURICE_DOCS_URL = url;
  expect(docsUrl()).toBe(url!);
});

test("the first check brings the published set down", async () => {
  publish(at(1), v1);
  expect(await refreshDocs()).toBe("refreshed");
  expect(fs.readdirSync(target).sort()).toEqual([INDEX, CHAT, LIFE, "manifest.json"].sort());
  expect(read(CHAT)).toBe(v1[CHAT]!);
  expect(readManifest(target)?.generated_at).toBe(at(1));
  expect(fs.existsSync(target + ".staging")).toBe(false);
  const status = docsStatus();
  expect(status.source).toBe("refreshed");
  expect(status.generated_at).toBe(at(1));
  expect(status.last_error).toBeNull();
  expect(status.last_check_at).not.toBeNull();
});

test("a manifest already seen writes nothing and fetches no note", async () => {
  const before = mtimes();
  hits.length = 0;
  expect(await refreshDocs()).toBe("unchanged");
  expect(hits).toEqual(["manifest.json"]);
  expect(mtimes()).toEqual(before);
});

test("a note whose hash does not match leaves the previous set intact", async () => {
  const v2 = { ...v1, [CHAT]: note("The chat experience", "2027-02-01", "Rewritten, but the manifest lies.") };
  publish(at(2), v2, CHAT);
  const before = mtimes();
  expect(await refreshDocs()).toBe("failed");
  expect(mtimes()).toEqual(before);
  expect(read(CHAT)).toBe(v1[CHAT]!);
  expect(readManifest(target)?.generated_at).toBe(at(1));
  expect(fs.existsSync(target + ".staging")).toBe(false);
  expect(docsStatus().last_error).toContain("sha256");
  expect(docsStatus().source).toBe("refreshed");
});

test("a note that left the manifest goes; an unchanged one is not downloaded", async () => {
  const v3: Record<string, string> = {
    [INDEX]: v1[INDEX]!,
    [CHAT]: note("The chat experience", "2027-02-01", "Rewritten, for real this time."),
  };
  publish(at(3), v3);
  hits.length = 0;
  expect(await refreshDocs()).toBe("refreshed");
  expect(fs.readdirSync(target).sort()).toEqual([INDEX, CHAT, "manifest.json"].sort());
  expect(read(CHAT)).toBe(v3[CHAT]!);
  expect(hits).toEqual(["manifest.json", CHAT]);
  expect(docsStatus().last_error).toBeNull();
});

test("docsDir() reads the refreshed set once it is newer than the bundle, and the tool reflects it", () => {
  expect(docsDir()).toBe(target);
  const docs = loadMauriceDocs();
  expect(docs.map((d) => d.slug)).toEqual(["maurice-docs", "maurice-chat"]);
  expect(docs.find((d) => d.slug === "maurice-chat")?.body).toContain("for real");
  // The set's date is the newest note date of the set actually read.
  expect(docsUpdatedAt()).toBe("2027-02-01");
});

test("a refreshed set older than the bundle yields to it", () => {
  const manifest = readManifest(target)!;
  fs.writeFileSync(
    path.join(target, "manifest.json"),
    JSON.stringify({ ...manifest, generated_at: "2000-01-01T00:00:00Z" }),
  );
  expect(docsDir()).toBe(bundledDocsDir());
  expect(docsStatus().source).toBe("bundled");
});
