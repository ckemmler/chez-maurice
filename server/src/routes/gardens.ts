import { Hono } from "hono";
import { getUser, listUsers, isGuest } from "../services/users";
import { getNote } from "../services/composer/notes";
import {
  gardensFor,
  gardenFor,
  setGardenTheme,
  sharesFor,
  tendsNote,
  addShare,
  removeSelf,
} from "../services/gardens";

// Shared gardens API (account-scoped via the /api/v1/* userId gate).
//
//   GET    /api/v1/gardens                         → every garden I belong to
//   PATCH  /api/v1/gardens/:id                     → set its web theme (any gardener)
//   GET    /api/v1/gardens/note/:owner/:slug/access → who tends a note
//   POST   /api/v1/gardens/note/:owner/:slug/share  → share wider (any tender)
//   POST   /api/v1/gardens/note/:owner/:slug/leave  → remove yourself — never others

const gardens = new Hono();

const SLUG_RE = /^[a-z0-9-]+$/;

gardens.get("/", (c) => {
  const memberId = c.get("userId") as string;
  // Guests have no garden — the section simply doesn't exist for them.
  if (isGuest(memberId)) return c.json({ gardens: [] });
  return c.json({ gardens: gardensFor(memberId) });
});

gardens.patch("/:id", async (c) => {
  const memberId = c.get("userId") as string;
  const id = c.req.param("id");
  if (!id.split("+").includes(memberId)) {
    return c.json({ error: "Not a gardener of this garden" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { web_theme?: string };
  const theme = (body.web_theme ?? "").trim();
  if (!theme || !/^[a-z0-9_-]+$/i.test(theme)) {
    return c.json({ error: "web_theme required" }, 400);
  }
  setGardenTheme(id, theme);
  return c.json({ ok: true, id, web_theme: theme });
});

// Who tends a note: every household member, flagged tends/is_owner/is_self —
// the access card renders Share buttons for the rest of the household.
gardens.get("/note/:owner/:slug/access", (c) => {
  const memberId = c.get("userId") as string;
  const ownerId = c.req.param("owner");
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) return c.json({ error: "Bad slug" }, 400);
  const owner = getUser(ownerId);
  if (!owner) return c.json({ error: "Unknown owner" }, 404);
  if (!tendsNote(ownerId, slug, memberId)) return c.json({ error: "Forbidden" }, 403);
  const note = getNote(ownerId, slug);
  if (!note) return c.json({ error: "Note not found" }, 404);

  const shared = new Set(sharesFor(ownerId, slug));
  const members = listUsers()
    .filter((u) => u.role !== "guest")
    .map((u) => ({
      member_id: u.id,
      username: u.username,
      display_name: u.display_name,
      avatar_color: u.avatar_color,
      avatar_url: u.avatar_url,
      tends: u.id === ownerId || shared.has(u.id),
      is_owner: u.id === ownerId,
      is_self: u.id === memberId,
    }));
  return c.json({ owner_id: ownerId, slug, title: note.title, members });
});

// Share wider: anyone tending the note may bring in another household member.
gardens.post("/note/:owner/:slug/share", async (c) => {
  const memberId = c.get("userId") as string;
  const ownerId = c.req.param("owner");
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) return c.json({ error: "Bad slug" }, 400);
  if (!tendsNote(ownerId, slug, memberId)) return c.json({ error: "Forbidden" }, 403);
  if (!getNote(ownerId, slug)) return c.json({ error: "Note not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { member_id?: string };
  const target = getUser(body.member_id ?? "");
  if (!target || target.role === "guest") return c.json({ error: "Unknown member" }, 400);
  addShare(ownerId, slug, target.id);
  return c.json({ ok: true });
});

// Remove yourself — never others. The owner hosts the note and can't leave it.
gardens.post("/note/:owner/:slug/leave", (c) => {
  const memberId = c.get("userId") as string;
  const ownerId = c.req.param("owner");
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) return c.json({ error: "Bad slug" }, 400);
  if (memberId === ownerId) {
    return c.json({ error: "You host this note — share or unshare it, but it stays yours" }, 400);
  }
  if (!tendsNote(ownerId, slug, memberId)) return c.json({ error: "Forbidden" }, 403);
  removeSelf(ownerId, slug, memberId);
  return c.json({ ok: true });
});

export default gardens;
