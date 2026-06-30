import type { APIRoute } from "astro";
import { buildSearchIndex } from "../utils/build-search-index";

export const GET: APIRoute = async () => {
  const index = await buildSearchIndex("en");
  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json" },
  });
};
