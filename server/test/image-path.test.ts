import { describe, it, expect } from "bun:test";
import { resolveImagePath, imagesDir } from "../src/services/images";
import { join } from "node:path";

// resolveImagePath is the one guard between a member-controlled filename (pulled
// from a message's ![](/api/images/<name>) markdown, capture group `(.+?)`) and a
// readFileSync into imagesDir. A traversal here is read and handed to the model.
describe("resolveImagePath", () => {
  it("accepts a plain generated filename", () => {
    expect(resolveImagePath("abc123.png")).toBe(join(imagesDir, "abc123.png"));
    expect(resolveImagePath("photo.jpg")).toBe(join(imagesDir, "photo.jpg"));
    // the .orig sidecar and any direct child are fine
    expect(resolveImagePath("abc123.png.orig")).toBe(join(imagesDir, "abc123.png.orig"));
  });

  it("refuses path traversal and separators", () => {
    for (const bad of [
      "../../../etc/passwd",
      "../../.ssh/id_rsa",
      "..%2f..%2fetc",       // not decoded here, but the slash-encoded literal has no slash — still a non-existent plain name, never a traversal
      "sub/dir.png",
      "/etc/hosts",
      "/Users/candide/.maurice/maurice.db",
      "",
    ]) {
      const r = resolveImagePath(bad);
      // Either rejected outright, or — for a name with no separator at all — kept
      // as a direct child of imagesDir. The security property is that the path
      // never escapes the directory, not that the literal filename is pretty.
      if (r !== null) {
        expect(r.startsWith(imagesDir + "/")).toBe(true);
        expect(r).toBe(join(imagesDir, bad));
      }
    }
    // the concrete attack from the review must resolve to null
    expect(resolveImagePath("../../.ssh/id_rsa")).toBeNull();
    expect(resolveImagePath("/etc/hosts")).toBeNull();
  });
});
