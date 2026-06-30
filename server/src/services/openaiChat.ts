// OpenAI-style Chat Completions client — shared by OpenAI and Mistral (Mistral's
// API is OpenAI-compatible). Distinct from Anthropic's Messages API; this is the
// `/chat/completions` SSE format where tool-call arguments stream in fragments.

export interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string }; // arguments is a JSON string
}

export type OpenAITurnEvent =
  | { type: "text"; text: string }
  | { type: "turn_end"; content: string; toolCalls: OpenAIToolCall[] }
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
  const body: any = { model, messages, stream: true };
  if (tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  if (temperature !== undefined) body.temperature = temperature;
  // Note: max-tokens param is omitted — OpenAI's o-series wants
  // max_completion_tokens while others want max_tokens; the defaults are ample.

  let response: Response;
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
        yield { type: "turn_end", content, toolCalls: collect(toolAcc) };
        return;
      }
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { continue; }
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
  yield { type: "turn_end", content, toolCalls: collect(toolAcc) };
}
