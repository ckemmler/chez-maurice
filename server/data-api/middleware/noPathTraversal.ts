import type { MiddlewareHandler } from "hono";

// The tracks/reports routers build filesystem paths straight from their
// :planId / :trackId params — resolve(tracksRoot, trackId, …, `${planId}.md`).
// Hono decodes %2F, so a param can smuggle in path separators or `..` and walk
// out of the tracks tree (read, write, delete, or render an arbitrary file).
// These ids are always plain slugs or plan ids, so reject at the door any
// request whose raw URL carries an encoded separator or a `..` segment — a
// single guard that can't be forgotten at one of the ~40 path-building sites.
const ENCODED_SEP = /%2f|%5c/i; // encoded / or \
const DOTDOT_SEGMENT = /(^|\/)\.\.(\/|$)/; // a real ".." path segment

export const noPathTraversal: MiddlewareHandler = async (c, next) => {
  const raw = c.req.path; // decoded path
  const url = c.req.url;   // still-encoded
  if (ENCODED_SEP.test(url) || DOTDOT_SEGMENT.test(raw) || raw.includes("\0")) {
    return c.json({ error: "Invalid path" }, 400);
  }
  return next();
};
