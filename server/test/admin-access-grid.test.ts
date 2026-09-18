/**
 * The admin's "who can use what" grid must only offer models the household can
 * actually call. A model whose provider has no key is never served to the apps
 * (`availableModels`), so a ticked box for it promised a member something they
 * would never see — and a save, which replaces a member's whole list, must not
 * drop the rows for models the grid chose not to show.
 */

import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const web = (await import("../src/routes/web-admin")).default;
const { createSession } = await import("../src/services/auth");
const { accessOutside, setAccess, allowedModelIds } = await import("../src/services/modelAccess");

let adminCookie = "";
const MEMBER = "grid-member";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`,
    ["grid-admin", "gridadmin", "Grid admin"],
  );
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`,
    [MEMBER, "gridmember", "Grid member"],
  );
  adminCookie = `maurice_admin=${createSession("grid-admin").token}`;
});

/** The dashboard as the admin sees it, through the localhost-only guard. */
async function dashboard(): Promise<string> {
  const res = await web.request("/dashboard", {
    headers: { Host: "localhost", Cookie: adminCookie },
  });
  expect(res.status).toBe(200);
  return res.text();
}

/** The checkbox the grid draws for one member and one model. */
const box = (modelId: string) => `value="${MEMBER}|${modelId}"`;

test("a model whose provider has no key is left out of the grid", async () => {
  db.run(`UPDATE households SET scaleway_api_key = NULL WHERE id = 'default'`);
  const html = await dashboard();
  expect(html).not.toContain(box("glm-5.2"));
  // And the absence is explained rather than silent.
  expect(html).toContain("Scaleway");
  expect(html).toMatch(/not listed|no API key/i);
});

test("the same model appears once its provider has a key", async () => {
  db.run(`UPDATE households SET scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  const html = await dashboard();
  expect(html).toContain(box("glm-5.2"));
  db.run(`UPDATE households SET scaleway_api_key = NULL WHERE id = 'default'`);
});

test("saving the grid keeps the rows for models it did not show", async () => {
  // The member was allowed a Scaleway model while the key was there.
  db.run(`UPDATE households SET scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  setAccess(MEMBER, "glm-5.2", true);
  expect(allowedModelIds(MEMBER)).toContain("glm-5.2");

  // The key goes away, so the grid stops showing that model…
  db.run(`UPDATE households SET scaleway_api_key = NULL WHERE id = 'default'`);
  const shown = new Set(
    (db.query(`SELECT id, provider FROM models`).all() as Array<{ id: string; provider: string }>)
      .filter((m) => m.provider !== "scaleway")
      .map((m) => m.id),
  );
  expect(accessOutside(MEMBER, shown)).toContain("glm-5.2");

  // …and a save of the grid, which ticks nothing for this member, leaves it be.
  const res = await web.request("/access", {
    method: "POST",
    headers: {
      Host: "localhost",
      Cookie: adminCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "",
  });
  expect(res.status).toBe(302);
  expect(allowedModelIds(MEMBER)).toContain("glm-5.2");
});

test("the guard still refuses a request that is not loopback", async () => {
  const res = await web.request("/dashboard", {
    headers: { Host: "aline.chezmaurice.eu", Cookie: adminCookie },
  });
  expect(res.status).toBe(403);
});
