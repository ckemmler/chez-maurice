import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname, basename } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const uploadsBase = resolve(repoRoot, "data", "uploads");

const app = new Hono();

app.post("/", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return c.json({ error: "file field is required" }, 400);
  }

  const overrideName = formData.get("filename") as string | null;
  const filename = overrideName || file.name;

  if (!filename) {
    return c.json({ error: "filename is required (either from file or filename field)" }, 400);
  }

  // Organize by YYYY-MM
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = resolve(uploadsBase, month);
  mkdirSync(dir, { recursive: true });

  // filename is client-supplied: resolve(dir, "../../foo") or an absolute path
  // would escape uploadsBase and let a caller drop a file anywhere the process
  // can write (a launchd plist → RCE). Strip to a bare basename and refuse
  // anything that isn't already one.
  const safe = basename(filename);
  if (safe !== filename || safe === "" || safe === "." || safe === "..") {
    return c.json({ error: "invalid filename" }, 400);
  }
  const dest = resolve(dir, safe);
  if (!dest.startsWith(uploadsBase + "/")) {
    return c.json({ error: "invalid filename" }, 400);
  }
  const buffer = await file.arrayBuffer();
  writeFileSync(dest, Buffer.from(buffer));

  return c.json(
    {
      path: `data/uploads/${month}/${safe}`,
      filename: safe,
      size: buffer.byteLength,
    },
    201,
  );
});

export default app;
