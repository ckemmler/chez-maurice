import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

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

  // filename is client-supplied: strip to a bare basename so it can't escape
  // txBase via .. or an absolute path (see uploads.ts).
  const safe = basename(filename);
  if (safe !== filename || safe === "" || safe === "." || safe === "..") {
    return c.json({ error: "invalid filename" }, 400);
  }
  const dest = resolve(dir, safe);
  if (!dest.startsWith(txBase + "/")) {
    return c.json({ error: "invalid filename" }, 400);
  }
  const buffer = await file.arrayBuffer();
  writeFileSync(dest, Buffer.from(buffer));

  return c.json(
    {
      path: `data/bank-transactions/${month}/${safe}`,
      filename: safe,
      size: buffer.byteLength,
      timestamp: date.toISOString(),
    },
    201,
  );
});

export default app;
