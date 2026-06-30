import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const txBase = resolve(repoRoot, "data", "bank-transactions");

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
    return c.json({ error: "filename is required" }, 400);
  }

  // Use provided timestamp or current time for directory organization
  const timestampStr = formData.get("timestamp") as string | null;
  const date = timestampStr ? new Date(timestampStr) : new Date();
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const dir = resolve(txBase, month);
  mkdirSync(dir, { recursive: true });

  const dest = resolve(dir, filename);
  const buffer = await file.arrayBuffer();
  writeFileSync(dest, Buffer.from(buffer));

  return c.json(
    {
      path: `data/bank-transactions/${month}/${filename}`,
      filename,
      size: buffer.byteLength,
      timestamp: date.toISOString(),
    },
    201,
  );
});

export default app;
