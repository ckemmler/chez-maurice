import { Hono } from "hono";
import { extname } from "path";
import {
  listLibrary, createFolder, updateFolder, deleteFolder,
  saveFile, updateFile, deleteFile, readFile,
} from "../services/files";

const files = new Hono();

// Every route needs an authenticated owner.
files.use("*", async (c, next) => {
  if (!c.get("userId")) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// GET /api/files — the whole library (flat folders + files + summary).
files.get("/", (c) => c.json(listLibrary(c.get("userId"))));

// ── folders ──────────────────────────────────────────────────────
files.post("/folder", async (c) => {
  const { parent_id, name } = await c.req.json().catch(() => ({}));
  if (!name) return c.json({ error: "name required" }, 400);
  return c.json(createFolder(c.get("userId"), parent_id ?? null, String(name)));
});
files.patch("/folder/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const patch: { name?: string; parent_id?: string | null } = {};
  if ("name" in body) patch.name = String(body.name);
  if ("parent_id" in body) patch.parent_id = body.parent_id ?? null;
  const f = updateFolder(c.get("userId"), c.req.param("id"), patch);
  return f ? c.json(f) : c.json({ error: "Not found" }, 404);
});
files.delete("/folder/:id", (c) => {
  deleteFolder(c.get("userId"), c.req.param("id"));
  return c.json({ ok: true });
});

// ── upload (multipart) — filed at birth into folder_id (null = root) ──
files.post("/upload", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  const folderId = (form.get("folder_id") as string | null) || null;
  const name = (form.get("name") as string | null) || file.name || "file";
  const buffer = Buffer.from(await file.arrayBuffer());
  return c.json(saveFile(c.get("userId"), folderId, name, buffer));
});

// ── files: rename / move / delete / raw ──────────────────────────
files.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const patch: { name?: string; folder_id?: string | null } = {};
  if ("name" in body) patch.name = String(body.name);
  if ("folder_id" in body) patch.folder_id = body.folder_id ?? null;
  const f = updateFile(c.get("userId"), c.req.param("id"), patch);
  return f ? c.json(f) : c.json({ error: "Not found" }, 404);
});
files.delete("/:id", (c) => {
  deleteFile(c.get("userId"), c.req.param("id"));
  return c.json({ ok: true });
});

// Raw bytes (owner only) — for previewing / attaching.
files.get("/:id/raw", (c) => {
  const f = readFile(c.get("userId"), c.req.param("id"));
  if (!f) return c.json({ error: "Not found" }, 404);
  const ext = extname(f.name).toLowerCase();
  const mime = ext === ".pdf" ? "application/pdf"
    : ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : f.kind === "text" ? "text/plain; charset=utf-8"
    : "application/octet-stream";
  return new Response(f.buffer, {
    headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="${f.name}"` },
  });
});

export default files;
