import { Hono } from "hono";
import {
  initPlacesTable,
  listPlaces,
  getPlace,
  createPlace,
  updatePlace,
  deletePlace,
  matchPlace,
} from "../services/places";

initPlacesTable();

const app = new Hono();

app.get("/", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  return c.json(listPlaces(memberId));
});

app.get("/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = Number(c.req.param("id"));
  const place = getPlace(memberId, id);
  if (!place) return c.json({ error: "Not found" }, 404);
  return c.json(place);
});

app.post("/", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json<{
    name?: string;
    lat?: number;
    lon?: number;
    radius?: number;
    icon?: string;
  }>();

  if (!body.name || body.lat == null || body.lon == null) {
    return c.json({ error: "name, lat, and lon are required" }, 400);
  }

  const place = createPlace(memberId, {
    name: body.name,
    lat: body.lat,
    lon: body.lon,
    radius: body.radius,
    icon: body.icon,
  });
  return c.json(place, 201);
});

app.put("/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    name?: string;
    lat?: number;
    lon?: number;
    radius?: number;
    icon?: string | null;
  }>();

  const place = updatePlace(memberId, id, body);
  if (!place) return c.json({ error: "Not found" }, 404);
  return c.json(place);
});

app.delete("/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = Number(c.req.param("id"));
  const ok = deletePlace(memberId, id);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.post("/match", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json<{ lat?: number; lon?: number }>();
  if (body.lat == null || body.lon == null) {
    return c.json({ error: "lat and lon are required" }, 400);
  }
  const place = matchPlace(memberId, body.lat, body.lon);
  return c.json(place ?? { match: null });
});

export default app;
