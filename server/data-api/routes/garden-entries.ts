/**
 * GET /api/v1/garden/entries — every entry in the member's garden, all
 * collections, newest first. The Carnet Garden section's list: it filters by
 * collection client-side and opens each face in the browser or an editor, so
 * one request returning everything beats a per-collection API for a tree this
 * size (hundreds of files).
 */

import { Hono } from "hono";
import { gardenFor } from "../services/gardenFiche";
import { GARDEN_COLLECTIONS, listGardenEntries } from "../services/gardenEntries";

const app = new Hono();

app.get("/entries", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  const entries = listGardenEntries(garden);
  return c.json({
    garden: {
      username: garden.username,
      collections: GARDEN_COLLECTIONS,
    },
    entries,
  });
});

export default app;
