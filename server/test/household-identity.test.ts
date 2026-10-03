/**
 * The foyer's face (PATCH /api/admin/settings → /api/health): the tower names a
 * household and gives it an icon and a colour when it makes it, and the apps'
 * switcher reads them back. A malformed icon or colour is refused rather than
 * stored, "" clears, and a member who is not an admin cannot touch any of it.
 */
import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { createSession } = await import("../src/services/auth");
const admin = (await import("../src/routes/admin")).default;

const BOSS = "identity-admin";
const ANNA = "identity-anna";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, role] of [[BOSS, "admin"], [ANNA, "standard"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)`, [id, id, id, role]);
  }
});

const patch = (who: string, body: unknown) =>
  admin.request("/settings", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createSession(who).token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const face = () => db.query(`SELECT name, icon, color FROM households WHERE id = 'default'`).get() as any;

test("name, icon and colour are set together and read back", async () => {
  const r = await patch(BOSS, { name: "Famille Magi-Kemmler", icon: "sailboat", color: "#2c5aa0" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ name: "Famille Magi-Kemmler", icon: "sailboat", color: "#2c5aa0" });
  expect(face()).toEqual({ name: "Famille Magi-Kemmler", icon: "sailboat", color: "#2c5aa0" });
});

test("a malformed icon or colour is refused and nothing is written", async () => {
  await patch(BOSS, { icon: "house", color: "#a6452e" });
  for (const body of [{ icon: "🏠" }, { icon: "house; drop" }, { color: "red" }, { color: "#12345" }, { icon: 3 }, { name: "X", color: "blue" }]) {
    expect((await patch(BOSS, body)).status).toBe(400);
  }
  expect(face()).toMatchObject({ icon: "house", color: "#a6452e" });
  expect(face().name).not.toBe("X");
});

test("an empty value clears the face back to the apps' derived one", async () => {
  await patch(BOSS, { icon: "leaf", color: "#3d6b4f" });
  expect((await patch(BOSS, { icon: "", color: null })).status).toBe(200);
  expect(face()).toMatchObject({ icon: null, color: null });
});

test("a member who is not an admin cannot change it", async () => {
  await patch(BOSS, { icon: "heart" });
  expect((await patch(ANNA, { icon: "leaf" })).status).toBe(403);
  expect(face().icon).toBe("heart");
});
