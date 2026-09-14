import type { APIRoute } from "astro";
import { buildSearchIndex } from "../utils/build-search-index";

export const GET: APIRoute = async ({ locals }) => {
  const index = await buildSearchIndex("en", locals.owner);
  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json" },
  });
};
