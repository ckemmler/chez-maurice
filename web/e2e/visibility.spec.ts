/**
 * Who sees what. The owner sees everything, drafts and private notes
 * included. Another member sees only what is shared with them. A guest and an
 * anonymous visitor see nothing. This is the proxy's contract and, after
 * phase 1, the engine's `owner` mode.
 */
import { test, expect, api } from "./helpers";

const G = "/g/theo";

test.describe("the owner", () => {
  test("sees drafts and private notes in the list, the search index and the detail", async ({ as }) => {
    const page = await as("theo");
    const list = await (await page.goto(`${G}/notes/`))!.text();
    expect(list).toContain("Draft packing list");
    expect(list).toContain("Secret budget");
    const index = await (await page.request.get(`${G}/search-index.json`)).text();
    expect(index).toContain("Draft packing list");
    expect(index).toContain("Secret budget");
    expect(await (await page.goto(`${G}/notes/draft-packing`))!.text()).toContain("DRAFT-MARKER-4410");
    expect(await (await page.goto(`${G}/notes/secret-budget`))!.text()).toContain("PRIVATE-MARKER-7731");
  });

  test("sees the toolbar", async ({ as }) => {
    const page = await as("theo");
    await page.goto(`${G}/notes/nara-deer`);
    await expect(page.locator("#dev-toolbar")).toHaveCount(1);
  });
});

test.describe("another member", () => {
  test("reads a note shared with them", async ({ as }) => {
    const page = await as("mei");
    const res = await page.goto(`${G}/notes/shared-with-mei`);
    expect(res?.status()).toBe(200);
    expect(await res!.text()).toContain("SHARED-MARKER-9902");
  });

  test("is refused everything else in that garden", async () => {
    for (const path of ["/", "/notes/", "/notes/nara-deer", "/notes/secret-budget", "/search-index.json", "/resources/books/"]) {
      const r = await api("mei", `${G}${path}`, { headers: { accept: "text/html", "sec-fetch-dest": "document" } });
      expect(r.status, path).toBe(403);
    }
  });

  test("finds no toolbar route in this garden to reach", async () => {
    // The engine serves none since phase 2; the API they do reach acts on
    // their own garden (toolbar.spec).
    const r = await api("mei", `${G}/_dev/public-state`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/notes/nara-deer" }),
    });
    expect(r.status).not.toBe(200);
  });

  test("sees no toolbar on the shared note, forged owner header or not", async ({ as }) => {
    const page = await as("mei");
    await page.goto(`${G}/notes/shared-with-mei`);
    await expect(page.locator("#dev-toolbar")).toHaveCount(0);
    const forged = await api("mei", `${G}/notes/shared-with-mei`, { headers: { accept: "text/html", "x-maurice-owner": "1" } });
    expect(forged.status).toBe(200);
    expect(await forged.text()).not.toContain('id="dev-toolbar"');
  });

  test("gets only public entries from the search index", async () => {
    // Not a document navigation, so the proxy lets it through as an asset —
    // the engine must not hand drafts and private notes to a non-owner.
    const r = await api("mei", `${G}/search-index.json`, { headers: { accept: "application/json", "x-maurice-owner": "1" } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("Kansai journal");
    expect(text).not.toContain("Draft packing list");
    expect(text).not.toContain("Secret budget");
  });

  test("has their own garden", async ({ as }) => {
    const page = await as("mei");
    const res = await page.goto(`/g/mei/notes/hello`);
    expect(res?.status()).toBe(200);
    expect(await res!.text()).toContain("MEI-MARKER");
  });
});

test.describe("a guest", () => {
  test("is refused, shared note included", async () => {
    for (const path of ["/", "/notes/shared-with-mei", "/notes/nara-deer"]) {
      const r = await api("visitor", `${G}${path}`, { headers: { accept: "text/html", "sec-fetch-dest": "document" } });
      expect(r.status, path).toBe(403);
    }
  });
});

test.describe("anonymous", () => {
  test("gets 401 and a page that says so", async ({ anonymous }) => {
    const res = await anonymous.goto(`${G}/notes/nara-deer`);
    expect(res?.status()).toBe(401);
    expect(await res!.text()).not.toContain("bow for crackers");
  });

  test("gets 401 on the search index and on assets", async () => {
    expect((await api(null, `${G}/search-index.json`)).status).toBe(401);
    expect((await api(null, `${G}/garden-activity.json`)).status).toBe(401);
  });
});

test("a member without a garden slug is sent to their own garden", async () => {
  const r = await api("theo", "/notes/nara-deer", { headers: { accept: "text/html", "sec-fetch-dest": "document" } });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe(`${G}/notes/nara-deer`);
});
