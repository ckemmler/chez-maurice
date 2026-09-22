import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Artifact resolution: which directory holds a book's chapters and summaries.
// The rule this suite pins down is that the *uuid* decides, not the path —
// Calibre rewrites `books.path` on every title or author edit, and the old
// layout lost every extracted chapter when it did.

const TMP = "/tmp/maurice-calibre-artifacts-test";
const LIB = path.join(TMP, "library");
const ARTIFACTS = path.join(TMP, "artifacts");
process.env.MAURICE_CALIBRE_ARTIFACTS_DIR = ARTIFACTS;

const {
  bookArtifactsDir,
  canonicalArtifactsDir,
  safeTitleSegment,
  invalidateArtifactsListing,
  readArtifactTexts,
  CHAPTERS_DIR,
} = await import("../data-api/services/calibreArtifacts");

const UUID = "3f7a1c22-8b4e-4d51-9a2f-77c0de1b9e10";

function seed(dir: string, file = "0001-Un chapitre.txt", body = "texte") {
  fs.mkdirSync(path.join(dir, CHAPTERS_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, CHAPTERS_DIR, file), body);
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  invalidateArtifactsListing();
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("artifact directory resolution", () => {
  it("puts a fresh book under the data dir, keyed by uuid", () => {
    const dir = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Camus/Le Mythe de Sisyphe (12)",
      uuid: UUID,
      title: "Le Mythe de Sisyphe",
    });
    expect(dir).toBe(path.join(ARTIFACTS, `${UUID}-Le Mythe de Sisyphe`));
    expect(dir.startsWith(LIB)).toBe(false);
  });

  it("survives a Calibre rename — the whole point", () => {
    // Extraction happens, then the title is edited in Calibre: `books.path` and
    // `books.title` both change. Under the old layout the chapters were gone.
    const before = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Camus/Le Mythe de Sisyphe (12)",
      uuid: UUID,
      title: "Le Mythe de Sisyphe",
    });
    seed(before);
    invalidateArtifactsListing();

    const after = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Albert Camus/Le mythe de Sisyphe — essai sur l'absurde (12)",
      uuid: UUID,
      title: "Le mythe de Sisyphe — essai sur l'absurde",
    });

    expect(after).toBe(before);
    expect(fs.existsSync(path.join(after, CHAPTERS_DIR, "0001-Un chapitre.txt"))).toBe(true);
  });

  it("keeps a pre-migration book in the library, reads and writes alike", () => {
    // Nothing under the data dir, artifacts in the library: stay there, so a
    // half-summarized book never splits across the two layouts.
    const legacy = path.join(LIB, "Camus/Le Mythe de Sisyphe (12)");
    seed(legacy);

    const dir = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Camus/Le Mythe de Sisyphe (12)",
      uuid: UUID,
      title: "Le Mythe de Sisyphe",
    });
    expect(dir).toBe(legacy);
  });

  it("prefers the new location once a book has been migrated", () => {
    const legacy = path.join(LIB, "Camus/Le Mythe de Sisyphe (12)");
    seed(legacy, "0001-ancien.txt");
    seed(canonicalArtifactsDir(UUID, "Le Mythe de Sisyphe"), "0001-nouveau.txt");
    invalidateArtifactsListing();

    const dir = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Camus/Le Mythe de Sisyphe (12)",
      uuid: UUID,
      title: "Le Mythe de Sisyphe",
    });
    expect(dir).toBe(canonicalArtifactsDir(UUID, "Le Mythe de Sisyphe"));
  });

  it("an empty artifact directory does not pin a book to the library", () => {
    // What a failed extraction leaves behind. Treating it as occupied would
    // strand the book at a location holding nothing.
    fs.mkdirSync(path.join(LIB, "Camus/Le Mythe de Sisyphe (12)"), { recursive: true });
    const dir = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Camus/Le Mythe de Sisyphe (12)",
      uuid: UUID,
      title: "Le Mythe de Sisyphe",
    });
    expect(dir).toBe(canonicalArtifactsDir(UUID, "Le Mythe de Sisyphe"));
  });

  it("falls back to the old layout for a library with no uuid column", () => {
    // Hand-built and very old libraries. Nothing stable to key on, so they keep
    // the layout they have rather than scatter artifacts under a null key.
    const dir = bookArtifactsDir({
      libraryRoot: LIB,
      bookPath: "Paola/Secret_18",
      uuid: null,
      title: "Paola Private Book",
    });
    expect(dir).toBe(path.join(LIB, "Paola/Secret_18"));
  });
});

describe("reading artifacts named by a client-supplied ref", () => {
  // `refs` arrives in a composer request body. Joining it to a path let `../`
  // read any file the server could reach; the fix is to serve only names the
  // directory listing actually returned.
  function fixture() {
    const dir = path.join(TMP, "book", CHAPTERS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "0001-Un chapitre.txt"), "le texte du chapitre");
    // A real, sensitive file one level up — the thing traversal would be after.
    fs.writeFileSync(path.join(TMP, "secret.txt"), "MAURICE_API_KEY=hunter2");
    return dir;
  }

  it("reads a legitimate ref", () => {
    const dir = fixture();
    expect(readArtifactTexts(dir, ["0001-Un chapitre"], ".txt")).toEqual([
      { ref: "0001-Un chapitre", text: "le texte du chapitre" },
    ]);
  });

  it("refuses to walk out of the directory, even to a file that exists", () => {
    const dir = fixture();
    const out = readArtifactTexts(dir, ["../../secret", "../secret"], ".txt");
    expect(out.map((o) => o.text)).toEqual(["", ""]);
    expect(out.every((o) => !o.text.includes("hunter2"))).toBe(true);
  });

  it("refuses an absolute path", () => {
    const dir = fixture();
    const abs = path.join(TMP, "secret");
    expect(readArtifactTexts(dir, [abs], ".txt")).toEqual([{ ref: abs, text: "" }]);
  });

  it("an unknown ref reads as empty, the same as a missing chapter", () => {
    const dir = fixture();
    expect(readArtifactTexts(dir, ["0099-Jamais écrit"], ".txt")).toEqual([
      { ref: "0099-Jamais écrit", text: "" },
    ]);
  });

  it("returns one entry per ref, in order", () => {
    // The caller zips these against its own list; dropping a bad ref instead of
    // returning it empty would silently shift every chapter after it.
    const dir = fixture();
    const out = readArtifactTexts(dir, ["../secret", "0001-Un chapitre", "absent"], ".txt");
    expect(out.map((o) => o.ref)).toEqual(["../secret", "0001-Un chapitre", "absent"]);
    expect(out.map((o) => o.text)).toEqual(["", "le texte du chapitre", ""]);
  });
});

describe("title segments", () => {
  it("keeps accents and punctuation a reader would recognise", () => {
    expect(safeTitleSegment("L'Être et le Néant")).toBe("L'Être et le Néant");
  });

  it("neutralises separators rather than dropping the title", () => {
    expect(safeTitleSegment("Vingt-quatre heures 24/7")).toBe("Vingt-quatre heures 24 7");
    expect(safeTitleSegment("a\\b")).toBe("a b");
  });

  it("never yields an empty or trailing-dot segment", () => {
    // An empty segment would make the directory the artifacts root itself;
    // trailing dots and spaces are silently dropped by some filesystems, which
    // would make what we created unfindable by the name we used.
    expect(safeTitleSegment("")).toBe("sans titre");
    expect(safeTitleSegment("///")).toBe("sans titre");
    expect(safeTitleSegment("Suite… ")).toBe("Suite…");
    expect(safeTitleSegment("Fin.")).toBe("Fin");
  });

  it("bounds length, leaving room for the uuid and a chapter filename", () => {
    expect(safeTitleSegment("é".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("truncates whole characters, not halves of one", () => {
    // Astral characters are two UTF-16 units: cutting by unit would leave a
    // lone surrogate in a directory name, and would disagree with the Python
    // side, which counts code points. The two must agree byte for byte —
    // maurice-tools/calibre/artifacts.py writes what this module reads.
    const cut = safeTitleSegment("📚".repeat(100));
    expect(Array.from(cut).length).toBe(80);
    expect(cut).toBe("📚".repeat(80));
  });
});
