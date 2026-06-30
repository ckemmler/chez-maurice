// Tavily web search — gives the assistant internet access as a tool.
// Key comes from TAVILY_API_KEY in the repo .env (loaded by index.ts).

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchResponse {
  answer?: string;
  results: WebSearchResult[];
}

export function hasWebSearch(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

/**
 * Run a Tavily search. Returns a short synthesized answer plus the top
 * source snippets. Throws on transport/HTTP failure so the caller can
 * surface a tool error back to the model.
 */
export async function webSearch(
  query: string,
  opts: { maxResults?: number } = {}
): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not configured");

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: Math.min(Math.max(opts.maxResults ?? 5, 1), 10),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Tavily ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as any;
  return {
    answer: data.answer || undefined,
    results: (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      content: r.content || "",
    })),
  };
}

/**
 * Format a search response as plain text for a tool_result block.
 */
export function formatWebSearch(res: WebSearchResponse): string {
  const parts: string[] = [];
  if (res.answer) parts.push(`Answer: ${res.answer}`);
  if (res.results.length) {
    parts.push(
      "Sources:\n" +
        res.results
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
          .join("\n\n")
    );
  }
  return parts.join("\n\n") || "No results found.";
}
