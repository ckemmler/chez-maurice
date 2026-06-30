import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";

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

  const dest = resolve(dir, filename);
  const buffer = await file.arrayBuffer();
  writeFileSync(dest, Buffer.from(buffer));

  return c.json(
    {
      path: `data/uploads/${month}/${filename}`,
      filename,
      size: buffer.byteLength,
    },
    201,
  );
});

export default app;
