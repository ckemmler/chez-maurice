// OpenAI-style Chat Completions client — shared by OpenAI and Mistral (Mistral's
// API is OpenAI-compatible). Distinct from Anthropic's Messages API; this is the
// `/chat/completions` SSE format where tool-call arguments stream in fragments.

export interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string }; // arguments is a JSON string
}

/** Token counts for one Chat Completions round, normalized across providers.
 *  `cached` is the slice of the prompt that was served from the provider's
 *  prompt cache (OpenAI reports it under prompt_tokens_details; providers that
 *  don't report it simply leave this at 0). */
export interface OpenAIUsage {
  prompt: number;
  completion: number;
  cached: number;
}

export type OpenAITurnEvent =
  | { type: "text"; text: string }
  | { type: "turn_end"; content: string; toolCalls: OpenAIToolCall[]; usage: OpenAIUsage | null }
  | { type: "error"; message: string };

/** Normalize a Chat Completions `delta.content` to plain text. It's usually a
 *  string, but some OpenAI-compatible providers (e.g. MiniMax) send it as an
 *  array of content parts — or a lone part object — especially around web-search
 *  citations. Appending those directly stringifies them to "[object Object]", so
 *  we extract the text and drop non-text parts (annotations/citations). */
function deltaText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(deltaText).join("");
  if (c && typeof c === "object") return typeof c.text === "string" ? c.text : "";
  return "";
}

function collect(acc: Record<number, { id: string; name: string; args: string }>): OpenAIToolCall[] {
  return Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => ({
      id: acc[k]!.id || crypto.randomUUID(),
      function: { name: acc[k]!.name, arguments: acc[k]!.args || "{}" },
    }));
}

/** One Chat Completions turn: streams content as `text`, accumulates tool calls
 *  (arguments arrive in fragments by index), finishes with `turn_end`. */
export async function* openaiTurn(
  baseUrl: string, // e.g. https://api.openai.com/v1
  apiKey: string,
  model: string,
  messages: any[],
  tools: any[],
  temperature: number | undefined,
): AsyncGenerator<OpenAITurnEvent> {
  // include_usage adds a final chunk carrying the round's token counts (it has
  // an empty `choices` array, so the parse loop below must read usage before it
  // bails on a missing delta).
  const body: any = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  if (temperature !== undefined) body.temperature = temperature;
  // Note: max-tokens param is omitted — OpenAI's o-series wants
  // max_completion_tokens while others want max_tokens; the defaults are ample.

  // "OpenAI-compatible" is a family resemblance, not a contract: some servers
  // ignore fields they don't know, others reject the request outright (Mistral
  // answers 422 "Extra inputs are not permitted" to an unknown key). Losing all
  // chat on a provider for the sake of a cost meter is a bad trade, so a
  // rejection retries once without the flag and simply reports no usage.
  let response: Response;
  let withUsage = true;
  for (;;) {
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      yield { type: "error", message: `${baseUrl} unreachable: ${err?.message || "error"}` };
      return;
    }
    // 400/422 are the shapes a strict server uses to refuse an unknown field.
    if (response.ok || !withUsage || (response.status !== 400 && response.status !== 422)) break;
    delete body.stream_options;
    withUsage = false;
  }
  if (!response.ok || !response.body) {
    let detail = "";
    try { detail = await response.text(); } catch {}
    yield { type: "error", message: `Provider error ${response.status}: ${detail.slice(0, 300)}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: OpenAIUsage | null = null;
  const toolAcc: Record<number, { id: string; name: string; args: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") {
        yield { type: "turn_end", content, toolCalls: collect(toolAcc), usage };
        return;
      }
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { continue; }
      // Read usage first: the chunk that carries it has no delta to speak of.
      if (chunk.usage) {
        usage = {
          prompt: chunk.usage.prompt_tokens ?? 0,
          completion: chunk.usage.completion_tokens ?? 0,
          cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const text = deltaText(delta.content);
      if (text) { content += text; yield { type: "text", text }; }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = (toolAcc[idx] ??= { id: "", name: "", args: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }
  }
  yield { type: "turn_end", content, toolCalls: collect(toolAcc), usage };
}
