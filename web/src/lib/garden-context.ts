/**
 * Whose garden this request is for.
 *
 * The engine used to be told once, by a `GARDEN` environment variable, which
 * is why a household ran one Astro process per member: the answer was baked
 * into the process. One built server serving every member needs the answer per
 * request instead, and the modules that need it — `garden.ts`, `notes-fs`,
 * `content-fs`, `fiche.ts` — are plain functions called deep inside a render,
 * with no access to `Astro`.
 *
 * `AsyncLocalStorage` is what carries it: the middleware opens a store for the
 * request and everything awaited inside sees it, without a single call site
 * having to pass the member down. Outside a request — the static publish, a
 * script — there is no store and the environment answers, exactly as before.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface GardenContext {
  /** The member whose garden is being served. */
  member: string;
  /** URL prefix this garden is served under ("/g/<member>", or "" at a root). */
  base: string;
  /** The request comes from the garden's owner. */
  owner: boolean;
  /** This page was shared with a viewer who is not the owner. */
  shared: boolean;
}

const storage = new AsyncLocalStorage<GardenContext>();

/** Run `fn` (and everything it awaits) as this garden's request. */
export function runInGarden<T>(context: GardenContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The member being served: the request's, else the process's, else the demo. */
export function currentGarden(): string {
  return storage.getStore()?.member || process.env.GARDEN || "demo";
}

/** The URL prefix this garden is served under, without a trailing slash. */
export function currentBase(): string {
  const base = storage.getStore()?.base ?? process.env.GARDEN_BASE ?? "";
  return base.replace(/\/+$/, "");
}

/** The whole context, when a caller needs more than the member. */
export function currentContext(): GardenContext | undefined {
  return storage.getStore();
}
