/**
 * A media entry shared with other members: who reads it, who signs what, and
 * what stays each member's own. Through the routes, since the question is what
 * a member is told. Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-shares-"));
const GARDENS = path.join(TMP, "gardens");
process.env.MAURICE_GARDENS_DIR = GARDENS;

const { default: routes } = await import("../data-api/routes/garden-entries");
const { noteBlock } = await import("../data-api/services/gardenWrite");
const { MEMBER } = await import("./_member");
const { default: db } = await import("../src/db");

const OTHER = { id: "share-aline", username: "aline-partage" };
const THIRD = { id: "share-emilio", username: "emilio-partage" };

const app = new Hono();
app.use("*", async (c, next) => {
  (c as any).set("userId", c.req.header("x-user"));
  await next();
});
app.route("/", routes);

const call = (who: { id: string }, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { "x-user": who.id, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;

const ENTRY = "/entries/books/fr/humus-partage";
const root = (username: string) => path.join(GARDENS, username);

beforeAll(() => {
  // Other suites set the variable too, at import: say it again before reading.
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  for (const u of [OTHER, THIRD]) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [u.id, u.username, u.username]);
  }
  for (const username of [MEMBER.username, OTHER.username, THIRD.username]) {
    fs.mkdirSync(root(username), { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
      spawnSync("git", args, { cwd: root(username) });
    }
  }
  const file = path.join(root(MEMBER.username), "books/fr/humus-partage-fiche.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    `---\ntitle: Humus\nresource_collection: books\nresource_id: humus-partage\ndate: '2026-08-23'\ntags: []\nlocale: fr\nmeta:\n  author: Gaspard Kœnig\n---\n\n## Commentaire\n\n2026-09-01 — Une note d'avant le partage.\n`);
});

afterAll(() => {
  db.run(`DELETE FROM entry_shares WHERE owner_id = ?`, [MEMBER.id]);
  db.run(`DELETE FROM users WHERE id IN (?, ?)`, [OTHER.id, THIRD.id]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the shape of a signed note", () => {
  test("the author opens the head, in both shapes", () => {
    expect(noteBlock("2026-10-11", { text: "Oui.", author: "aline" })).toBe("2026-10-11 — @aline — Oui.");
    expect(noteBlock("2026-10-11", { text: "Oui.", where: { page: "12" }, author: "aline" }))
      .toBe("2026-10-11 — @aline — p. 12 :\n\nOui.");
    expect(noteBlock("2026-10-11", { text: "Un.\n\nDeux.", author: "aline" })).toBe("2026-10-11 — @aline :\n\nUn.\n\nDeux.");
  });
});

describe("sharing an entry", () => {
  test("an entry that is not shared does not exist for another member", async () => {
    expect((await call(OTHER, "GET", `${ENTRY}?owner=${MEMBER.username}`)).status).toBe(404);
    expect((await call(OTHER, "POST", `${ENTRY}/notes?owner=${MEMBER.username}`, { text: "Non." })).status).toBe(404);
  });

  test("the owner adds a member, who then lists and reads it — the earlier notes too", async () => {
    const shared = await call(MEMBER, "POST", `${ENTRY}/participants`, { username: OTHER.username });
    expect(shared.status).toBe(201);
    const mine = await json(shared);
    expect(mine.owner).toBeNull();
    expect(mine.participants.map((p: any) => p.username)).toEqual([OTHER.username]);

    const list = await json(await call(OTHER, "GET", "/entries?view=shelf"));
    const row = list.entries.find((e: any) => e.id === `@${MEMBER.username}/books/fr/humus-partage`);
    expect(row.owner.username).toBe(MEMBER.username);

    const theirs = await json(await call(OTHER, "GET", `${ENTRY}?owner=${MEMBER.username}`));
    expect(theirs.owner.username).toBe(MEMBER.username);
    const notes = theirs.mine.items.filter((i: any) => i.kind === "note");
    expect(notes.map((n: any) => [n.text, n.author.username])).toEqual([["Une note d'avant le partage.", MEMBER.username]]);

    // And the owner's own list names who it is shared with.
    const own = await json(await call(MEMBER, "GET", "/entries?view=shelf"));
    expect(own.entries.find((e: any) => e.id === "books/fr/humus-partage").participants.length).toBe(1);
  });

  test("a member's note lands on the owner's fiche, signed, and reads back under their name", async () => {
    const res = await call(OTHER, "POST", `${ENTRY}/notes?owner=${MEMBER.username}`, { text: "Ce que j'en pense." });
    expect(res.status).toBe(201);
    const file = fs.readFileSync(path.join(root(MEMBER.username), "books/fr/humus-partage-fiche.md"), "utf-8");
    expect(file).toContain(`— @${OTHER.username} — Ce que j'en pense.`);
    // Nothing was written in the member's own garden.
    expect(fs.existsSync(path.join(root(OTHER.username), "books"))).toBe(false);

    const seen = await json(await call(MEMBER, "GET", ENTRY));
    const by = Object.fromEntries(seen.mine.items.filter((i: any) => i.kind === "note").map((n: any) => [n.text, n.author.username]));
    expect(by).toEqual({ "Une note d'avant le partage.": MEMBER.username, "Ce que j'en pense.": OTHER.username });
  });

  test("a note that opens on an @ naming nobody keeps its text", async () => {
    await call(MEMBER, "POST", `${ENTRY}/notes`, { text: "@personne — n'est pas un membre." });
    const seen = await json(await call(MEMBER, "GET", ENTRY));
    const note = seen.mine.items.find((i: any) => i.text.includes("personne"));
    expect(note.text).toBe("@personne — n'est pas un membre.");
    expect(note.author.username).toBe(MEMBER.username);
  });

  test("a note kept from a conversation names who started it", async () => {
    db.run(`INSERT OR IGNORE INTO conversations (id, user_id, title) VALUES ('share-convo', ?, 'Le ver')`, [OTHER.id]);
    await call(OTHER, "POST", `${ENTRY}/notes?owner=${MEMBER.username}`, {
      text: "Le ver est le héros. *([Conversation avec Maurice](maurice://conversations/share-convo))*",
    });
    const seen = await json(await call(MEMBER, "GET", ENTRY));
    const note = seen.mine.items.find((i: any) => i.conversation);
    expect(note.conversation.id).toBe("share-convo");
    expect(note.conversation.initiator.username).toBe(OTHER.username);
    db.run(`DELETE FROM conversations WHERE id = 'share-convo'`);
  });

  test("only the owner adds or removes someone else; a member takes themselves off", async () => {
    // A member cannot share it further: the route is the owner's, on their own garden.
    expect((await call(OTHER, "POST", `${ENTRY}/participants`, { username: THIRD.username })).status).toBe(404);
    await call(MEMBER, "POST", `${ENTRY}/participants`, { username: THIRD.username });
    expect((await call(OTHER, "DELETE", `${ENTRY}/participants/${THIRD.id}?owner=${MEMBER.username}`)).status).toBe(403);

    expect((await call(OTHER, "DELETE", `${ENTRY}/participants/${OTHER.id}?owner=${MEMBER.username}`)).status).toBe(200);
    expect((await call(OTHER, "GET", `${ENTRY}?owner=${MEMBER.username}`)).status).toBe(404);

    const after = await json(await call(MEMBER, "DELETE", `${ENTRY}/participants/${THIRD.id}`));
    expect(after.participants).toEqual([]);
  });

  test("deleting the entry leaves no share behind", async () => {
    await call(MEMBER, "POST", `${ENTRY}/participants`, { username: OTHER.username });
    expect((await call(MEMBER, "DELETE", ENTRY)).status).toBeLessThan(300);
    expect(db.query(`SELECT COUNT(*) AS n FROM entry_shares WHERE owner_id = ?`).get(MEMBER.id)).toEqual({ n: 0 });
  });
});

describe("what a share does not open", () => {
  test("a member cannot change the entry: every other write is refused, and never lands in their own garden", async () => {
    const mine = path.join(root(OTHER.username), "books/fr/lombric-fiche.md");
    const theirs = path.join(root(MEMBER.username), "books/fr/lombric-fiche.md");
    for (const file of [mine, theirs]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\ntitle: Lombric\nresource_collection: books\nresource_id: lombric\ndate: '2026-08-23'\ntags: []\nlocale: fr\n---\n`);
    }
    const url = "/entries/books/fr/lombric";
    await call(MEMBER, "POST", `${url}/participants`, { username: OTHER.username });

    for (const [method, suffix, body] of [
      ["DELETE", "", undefined], ["PUT", "/shared", { body: "À moi." }], ["POST", "/shared/publish", undefined], ["POST", "/details", undefined],
    ] as const) {
      expect((await call(OTHER, method, `${url}${suffix}?owner=${MEMBER.username}`, body)).status).toBe(403);
    }
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(theirs)).toBe(true);

    // The owner's card is not part of what is shared.
    fs.writeFileSync(path.join(root(MEMBER.username), "books/fr/lombric.md"), `---\ntitle: Lombric\nflags: []\nlocale: fr\n---\nUn brouillon du propriétaire.\n`);
    const seen = await json(await call(OTHER, "GET", `${url}?owner=${MEMBER.username}`));
    expect(seen.shared).toBeNull();
    expect((await json(await call(MEMBER, "GET", url))).shared.body).toContain("brouillon");
  });
});
