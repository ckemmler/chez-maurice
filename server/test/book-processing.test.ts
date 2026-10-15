import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { Database } from "bun:sqlite";

// Chapters and summaries made in the server (services/bookProcessing.ts), which
// is what lets a hosted household — no private Python tool, no macOS binary —
// extract a book and have it summarized on its own model.

const TMP = "/tmp/maurice-book-processing-test";
const LIB = path.join(TMP, "library");
process.env.MAURICE_CALIBRE_ARTIFACTS_DIR = path.join(TMP, "artifacts");

const { MEMBER } = await import("./_member");
const db = (await import("../src/db")).default;
const { ZipReader } = await import("../data-api/services/zipReader");
const { epubSections, chapterFileName } = await import("../data-api/services/epubChapters");
const { extractChapters, summarizeChapters, summarizationPrompt, isFiction, BookProcessingError } =
  await import("../data-api/services/bookProcessing");
const { invalidateLibraryRoot, listChapters } = await import("../data-api/services/calibre");
const { invalidateArtifactsListing } = await import("../data-api/services/calibreArtifacts");

// ── Building EPUBs ──

function zip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    // The mimetype is stored, as the EPUB spec wants; the rest deflated.
    const method = deflate && name !== "mimetype" ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = Bun.hash.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{}</style></head><body>${body}</body></html>`;

// Two files: a header, then chapters I and II inside the first (cut at their
// anchors), chapter III alone in the second.
const TEXT_1 = xhtml(`
  <p>The Project Header: free for anyone.</p>
  <h2 id="ch1">I</h2>
  <p>One morning, Gregor woke   from troubled dreams.</p>
  <p>He lay on his <i>armour-like</i> back.</p>
  <h2 id="ch2">II</h2>
  <p>It was not until it was getting dark.</p>`);
const TEXT_2 = xhtml(`<h2>III</h2><p>After almost two months.</p><script>bad()</script>`);

function opf(toc: "nav" | "ncx" | "none") {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Metamorphosis</dc:title></metadata>
  <manifest>
    ${toc === "nav" ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` : ""}
    ${toc === "ncx" ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` : ""}
    <item id="t1" href="text/part%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="t2" href="text/part2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine${toc === "ncx" ? ` toc="ncx"` : ""}><itemref idref="t1"/><itemref idref="t2"/></spine>
</package>`;
}

const NAV = xhtml(`<nav epub:type="toc"><ol>
  <li><a href="text/part%201.xhtml#ch1">I</a></li>
  <li><a href="text/part%201.xhtml#ch2">II</a></li>
  <li><a href="text/part2.xhtml">III</a></li>
</ol></nav>`);

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="a"><navLabel><text>I</text></navLabel><content src="text/part%201.xhtml#ch1"/>
    <navPoint id="b"><navLabel><text>II</text></navLabel><content src="text/part%201.xhtml#ch2"/></navPoint>
  </navPoint>
  <navPoint id="c"><navLabel><text>III</text></navLabel><content src="text/part2.xhtml"/></navPoint>
</navMap></ncx>`;

function epub(toc: "nav" | "ncx" | "none", deflate = true): Buffer {
  return zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": opf(toc),
    ...(toc === "nav" ? { "OEBPS/nav.xhtml": NAV } : {}),
    ...(toc === "ncx" ? { "OEBPS/toc.ncx": NCX } : {}),
    "OEBPS/text/part 1.xhtml": TEXT_1,
    "OEBPS/text/part2.xhtml": TEXT_2,
  }, deflate);
}

describe("ZipReader", () => {
  it("reads stored and deflated entries alike", () => {
    const stored = new ZipReader(epub("nav", false));
    const deflated = new ZipReader(epub("nav", true));
    expect(stored.text("OEBPS/nav.xhtml")).toBe(NAV);
    expect(deflated.text("OEBPS/nav.xhtml")).toBe(NAV);
    expect(deflated.text("mimetype")).toBe("application/epub+zip");
    expect(deflated.read("missing")).toBeNull();
  });

  it("refuses what is not a zip", () => {
    expect(() => new ZipReader(Buffer.from("not a zip at all, not even close"))).toThrow("not a zip");
  });
});

describe("epubSections", () => {
  for (const toc of ["nav", "ncx"] as const) {
    it(`cuts at the table of contents (${toc})`, () => {
      const s = epubSections(epub(toc));
      expect(s.map((x) => x.title)).toEqual(["none", "I", "II", "III"]);
      expect(s[0]!.text).toBe("The Project Header: free for anyone.\n");
      expect(s[1]!.text).toBe("I\n\nOne morning, Gregor woke from troubled dreams.\n\nHe lay on his armour-like back.\n");
      expect(s[2]!.text).toBe("II\n\nIt was not until it was getting dark.\n");
      // The second file starts chapter III; a script is not text.
      expect(s[3]!.text).toBe("III\n\nAfter almost two months.\n");
    });
  }

  it("falls back to one chapter per spine document", () => {
    const s = epubSections(epub("none"));
    expect(s.map((x) => x.title)).toEqual(["The Project Header: free for anyone.", "III"]);
    expect(s[0]!.text).toContain("Gregor woke");
  });

  it("names chapter files the way the reader parses them", () => {
    expect(chapterFileName(7, "THE FULL PROJECT GUTENBERG™ LICENSE")).toBe("0007-THE FULL PROJECT GUTENBERG™ LICENSE.txt");
    expect(chapterFileName(1, "Part 1/2: a\tb.")).toBe("0001-Part 1 2: a b.txt");
    expect(chapterFileName(12, "")).toBe("0012-none.txt");
  });
});

describe("the summary prompt", () => {
  it("is the Python pipeline's, story so far included", () => {
    const p = summarizationPrompt("TEXT", [["I", "Gregor wakes."]], true);
    expect(p).toBe(
      "## Story so far\n\nHere is what has happened in the book up to this point:\n\n### I\nGregor wakes.\n\n---\n\n" +
      "## Current chapter\n\n" +
      "Condense this chapter into 300–500 words of flowing narrative prose. Retell what happens — who does what, key events, what changes, what's revealed. Write in present tense, in the voice and style of the original. Do NOT use bullet points, lists, or meta-commentary about the text.\n\nTEXT",
    );
    expect(summarizationPrompt("TEXT", [], false)).toStartWith("## Current chapter\n\nCondense this chapter into 300–500 words of flowing prose. Capture the key arguments");
  });

  it("reads fiction from the tags", () => {
    expect(isFiction(["Fiction"])).toBe(true);
    expect(isFiction(["Metamorphosis -- Fiction", "Psychological fiction"])).toBe(true);
    expect(isFiction(["Non-fiction"])).toBe(false);
    expect(isFiction(["Philosophy"])).toBe(false);
  });
});

// ── A real (minimal) Calibre library ──

let savedLibraries: unknown[] = [];
// Other suites in this process move MAURICE_DATA_DIR and the Calibre variables
// and do not all put them back: pin what this one depends on, for its duration.
const PINNED = {
  CALIBRE_LIBRARY_PATH: LIB,
  MAURICE_CALIBRE_ARTIFACTS_DIR: path.join(TMP, "artifacts"),
  CALIBRE_DB_PATH: undefined,
} as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(PINNED)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  const bookDir = path.join(LIB, "Franz Kafka", "Metamorphosis (1)");
  fs.mkdirSync(bookDir, { recursive: true });
  // Each chapter well past the 1 000 bytes under which the reader skips one.
  const long = (s: string) => Array.from({ length: 150 }, () => `<p>${s}</p>`).join("");
  fs.writeFileSync(path.join(bookDir, "Metamorphosis - Franz Kafka.epub"), zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": opf("nav"),
    "OEBPS/nav.xhtml": NAV,
    "OEBPS/text/part 1.xhtml": xhtml(`<p>Header.</p><h2 id="ch1">I</h2>${long("Gregor woke.")}<h2 id="ch2">II</h2>${long("It was dark.")}`),
    "OEBPS/text/part2.xhtml": xhtml(`<h2>III</h2>${long("Two months.")}`),
  }));

  const meta = new Database(path.join(LIB, "metadata.db"), { create: true });
  meta.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, uuid TEXT, timestamp TEXT, series_index REAL DEFAULT 1.0);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
    CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, uncompressed_size INTEGER, name TEXT);
    INSERT INTO books (id, title, path, uuid) VALUES (1, 'Metamorphosis', 'Franz Kafka/Metamorphosis (1)', '6a0e3d2c-1111-4222-8333-944455556666');
    INSERT INTO authors (id, name) VALUES (1, 'Franz Kafka');
    INSERT INTO books_authors_link (book, author) VALUES (1, 1);
    INSERT INTO tags (id, name) VALUES (1, 'Fiction');
    INSERT INTO books_tags_link (book, tag) VALUES (1, 1);
    INSERT INTO data (book, format, name) VALUES (1, 'EPUB', 'Metamorphosis - Franz Kafka');
  `);
  meta.close();

  // The library is the admin's default — the one row the resolver reads.
  savedLibraries = db.query(`SELECT * FROM calibre_libraries`).all();
  db.run(`DELETE FROM calibre_libraries`);
  db.run(`INSERT INTO calibre_libraries (id, account_id, label, library_root, is_default) VALUES (?, ?, 'Test', ?, 1)`,
    [crypto.randomUUID(), MEMBER.id, LIB]);
  invalidateLibraryRoot();
  invalidateArtifactsListing();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db.run(`DELETE FROM calibre_libraries`);
  for (const row of savedLibraries as Array<Record<string, unknown>>) {
    db.run(`INSERT INTO calibre_libraries (id, account_id, label, library_root, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.account_id, row.label, row.library_root, row.is_default, row.created_at] as any);
  }
  invalidateLibraryRoot();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("a book, extracted and summarized in the server", () => {
  it("refuses to summarize before there are chapters", async () => {
    await expect(summarizeChapters(1, MEMBER.id, async () => { throw new Error("no call expected"); }))
      .rejects.toBeInstanceOf(BookProcessingError);
  });

  it("extracts the EPUB into the reader's chapters", async () => {
    expect(await extractChapters(1)).toEqual({ chapters: 4, format: "EPUB" });
    const chapters = await listChapters(1);
    // The header is `none` and short: the reader leaves it out.
    expect(chapters!.map((c) => c.slug)).toEqual(["0002-I", "0003-II", "0004-III"]);
    expect(chapters!.every((c) => !c.hasSummary)).toBe(true);
  });

  it("summarizes in order, each chapter with the ones before it", async () => {
    const prompts: string[] = [];
    const complete = async (req: any) => {
      prompts.push(req.prompt);
      expect(req.invocation).toBe("chapter_summary");
      expect(req.system).toContain("condensed chapter summaries");
      return { text: `Summary ${prompts.length}.`, model: "test-model", provider: "test", stop: "end" as const, usage: null };
    };
    const r = await summarizeChapters(1, MEMBER.id, complete as any);
    expect(r.created).toBe(3);
    expect(r.skipped).toBe(0);
    expect(prompts[0]).toStartWith("## Current chapter");
    expect(prompts[2]).toContain("## Story so far");          // a Fiction tag
    expect(prompts[2]).toContain("### I\nSummary 1.");
    expect(prompts[2]).toContain("### II\nSummary 2.");

    const chapters = await listChapters(1);
    expect(chapters!.every((c) => c.hasSummary)).toBe(true);
    const dir = fs.readdirSync(path.join(TMP, "artifacts")).find((d) => d.startsWith("6a0e3d2c"))!;
    const meta = JSON.parse(fs.readFileSync(path.join(TMP, "artifacts", dir, "chapter_summaries", "metadata.json"), "utf8"));
    expect(meta["0004-III"]).toMatchObject({ pipeline: "context-chained-v1", context_chapters: 2 });
  });

  it("resumes: what is summarized is read for context, not asked again", async () => {
    const dir = fs.readdirSync(path.join(TMP, "artifacts")).find((d) => d.startsWith("6a0e3d2c"))!;
    fs.rmSync(path.join(TMP, "artifacts", dir, "chapter_summaries", "0004-III.summary.txt"));
    const prompts: string[] = [];
    const r = await summarizeChapters(1, MEMBER.id, (async (req: any) => {
      prompts.push(req.prompt);
      return { text: "Again.", model: "test-model", provider: "test", stop: "end", usage: null };
    }) as any);
    expect(r).toMatchObject({ created: 1, skipped: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("### II\nSummary 2.");
  });

  it("stops on a refusal and keeps what was written", async () => {
    const dir = fs.readdirSync(path.join(TMP, "artifacts")).find((d) => d.startsWith("6a0e3d2c"))!;
    fs.rmSync(path.join(TMP, "artifacts", dir, "chapter_summaries", "0004-III.summary.txt"));
    await expect(summarizeChapters(1, MEMBER.id, (async () =>
      ({ text: "", model: "m", provider: "p", stop: "refusal", usage: null })) as any)).rejects.toThrow("declined");
    const chapters = await listChapters(1);
    expect(chapters!.map((c) => c.hasSummary)).toEqual([true, true, false]);
  });
});
