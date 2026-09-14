/**
 * What every spec needs: the seeded state, a browser context logged in as a
 * member (the maurice_session cookie, exactly what the app's "open in
 * browser" sets), and the garden's files for live-edit tests.
 */
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { readState, type State } from "./stack";

export type Member = "hana" | "theo" | "mei" | "visitor";

export const state: State = readState();

export function garden(member = "theo"): string {
  return join(state.gardensDir, member);
}

export function noteFile(slug: string, locale = "en", member = "theo"): string {
  return join(garden(member), "notes", locale, `${slug}.md`);
}

export const notes = {
  read: (slug: string, locale = "en") => readFileSync(noteFile(slug, locale), "utf8"),
  write: (slug: string, title: string, body: string, flags: string[] = ["public"], locale = "en") =>
    writeFileSync(noteFile(slug, locale), `---\ntitle: ${title}\ndate: 2024-09-01\nflags: [${flags.join(", ")}]\nlocale: ${locale}\n---\n\n${body}\n`),
  remove: (slug: string, locale = "en") => { const f = noteFile(slug, locale); if (existsSync(f)) unlinkSync(f); },
  exists: (slug: string, locale = "en") => existsSync(noteFile(slug, locale)),
};

export const test = base.extend<{ as: (member: Member) => Promise<Page>; anonymous: Page }>({
  as: async ({ browser, baseURL }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (member) => {
      const ctx = await browser.newContext({ baseURL });
      await ctx.addCookies([{ name: "maurice_session", value: state.sessions[member]!, url: baseURL! }]);
      contexts.push(ctx);
      return ctx.newPage();
    });
    for (const c of contexts) await c.close();
  },
  anonymous: async ({ browser, baseURL }, use) => {
    const ctx = await browser.newContext({ baseURL });
    await use(await ctx.newPage());
    await ctx.close();
  },
});

export { expect };

/** Fetch as a member through the proxy, without a browser. */
export async function api(member: Member | null, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (member) headers.set("Cookie", `maurice_session=${state.sessions[member]}`);
  return fetch(`http://127.0.0.1:${state.apiPort}${path}`, { ...init, headers, redirect: "manual" });
}
