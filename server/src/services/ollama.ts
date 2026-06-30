import os from "node:os";
import db from "../db";
import { addModel, listModels, getModel, type Model } from "./models";

// Ollama on the household Mac mini: discovery (GET /api/tags) and streaming
// inference (POST /api/chat). Local models are private and metered-free.

export interface StreamEvent {
  type: "text_delta" | "done" | "error";
  text?: string;
  message_id?: string;
  message?: string;
}

// Cap the context window. Models advertise huge windows (qwen3.6 = 128K); letting
// Ollama allocate that KV cache costs ~30s+ on first load and a lot of RAM on a
// 48GB box. 32K is plenty for a household chat + persona context + tool results,
// and keeps cold starts to just the weight load (~8s).
const OLLAMA_NUM_CTX = 32768;
// Keep the model resident indefinitely (-1) so there's no ~8s cold reload after
// idle. Fine when the household leans on one local model on a 48GB box.
const OLLAMA_KEEP_ALIVE = -1;

export function ollamaHost(): string {
  const row = db
    .query(`SELECT ollama_host FROM households WHERE id = 'default'`)
    .get() as { ollama_host: string } | null;
  return (row?.ollama_host || "http://localhost:11434").replace(/\/+$/, "");
}

/** Total RAM of the host the server runs on (the Mac mini), in GB (GiB). */
export function totalRamGB(): number {
  return Math.round(os.totalmem() / 1024 ** 3);
}

// "qwen2.5:32b" → "Qwen2.5 32B"; "deepseek-r1:32b" → "DeepSeek-R1 32B".
function friendlyName(tag: string): string {
  const [base, size] = tag.split(":");
  const name = (base || tag)
    .split(/[-_]/)
    .map((p) => (/^r\d|^v\d/i.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
  return size ? `${name} ${size.toUpperCase()}` : name;
}

interface DiscoverResult {
  connected: boolean;
  host: string;
  version: string;
  count: number;
  totalRamGB: number;
  error?: string;
}

async function fetchJson(url: string, init?: RequestInit, ms = 4000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Best-effort context window (k tokens) for a tag via /api/show. */
async function contextK(host: string, tag: string): Promise<number> {
  try {
    const info = await fetchJson(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag }),
    }, 3000);
    const mi = info?.model_info || {};
    const key = Object.keys(mi).find((k) => k.endsWith(".context_length"));
    const n = key ? Number(mi[key]) : 0;
    return n > 0 ? Math.round(n / 1000) : 8;
  } catch {
    return 8;
  }
}

/** Fast liveness check for the dashboard (no model upserts). */
export async function ping(): Promise<{ connected: boolean; host: string; version: string }> {
  const host = ollamaHost();
  try {
    const ver = await fetchJson(`${host}/api/version`, undefined, 1500);
    return { connected: true, host, version: ver?.version || "" };
  } catch {
    return { connected: false, host, version: "" };
  }
}

/** Poll Ollama, upsert discovered local models, prune ones that vanished. */
export async function discover(): Promise<DiscoverResult> {
  const host = ollamaHost();
  const out: DiscoverResult = { connected: false, host, version: "", count: 0, totalRamGB: totalRamGB() };
  let tags: any;
  try {
    tags = await fetchJson(`${host}/api/tags`);
  } catch (e: any) {
    return { ...out, error: e?.message || "unreachable" };
  }
  out.connected = true;
  try {
    const ver = await fetchJson(`${host}/api/version`, undefined, 2000);
    out.version = ver?.version || "";
  } catch {}

  const entries: any[] = Array.isArray(tags?.models) ? tags.models : [];
  const seen = new Set<string>();
  for (const e of entries) {
    const tag: string = e.name || e.model;
    if (!tag) continue;
    // Embedding models can't chat — skip them.
    if (/embed/i.test(tag) || /embed/i.test(e?.details?.family || "")) continue;
    seen.add(tag);
    const ram = e.size ? Math.max(1, Math.round(e.size / 1e9)) : 0;
    // Reuse a previously-probed context window so re-scans stay fast.
    const existing = getModel(tag);
    const ctx = existing?.ctx ? existing.ctx : await contextK(host, tag);
    addModel({
      id: tag,
      name: friendlyName(tag),
      tier: "local",
      vendor: "Ollama",
      ctx,
      ram,
      discovered: true,
      descr: e?.details?.parameter_size
        ? `${e.details.parameter_size} · on-device`
        : "On-device via Ollama.",
    });
  }

  // Prune discovered-local models Ollama no longer reports (manual ones stay).
  for (const m of listModels()) {
    if (m.tier === "local" && m.discovered && !seen.has(m.id)) {
      db.run(`DELETE FROM models WHERE id = ?`, [m.id]);
    }
  }

  out.count = entries.length;
  return out;
}

export interface OllamaToolCall {
  function: { name: string; arguments: any };
}

export type OllamaTurnEvent =
  | { type: "text"; text: string }
  | { type: "turn_end"; content: string; toolCalls: OllamaToolCall[] }
  | { type: "error"; message: string };

/** One Ollama chat turn: streams content as `text` events, accumulates any
 *  tool calls, and finishes with `turn_end`. The agentic loop lives in the
 *  caller (claude.ts), which executes the tools and calls again. */
export async function* ollamaTurn(
  model: string,
  messages: any[],
  tools: any[],
  maxTokens: number,
): AsyncGenerator<OllamaTurnEvent> {
  const host = ollamaHost();
  // think:false — skip the (silent, very slow) reasoning phase of thinking
  // models like Qwen3/DeepSeek-R1. It streamed nothing to the client during
  // thinking, which blew past the request timeout. Non-thinking models ignore it.
  const body: any = { model, messages, stream: true, think: false, keep_alive: OLLAMA_KEEP_ALIVE, options: { num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX } };
  if (tools.length) body.tools = tools;

  let response: Response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    yield { type: "error", message: `Ollama unreachable at ${host}: ${err?.message || "error"}` };
    return;
  }
  if (!response.ok || !response.body) {
    let detail = "";
    try { detail = await response.text(); } catch {}
    yield { type: "error", message: `Ollama error ${response.status}: ${detail}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: OllamaToolCall[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let evt: any;
      try { evt = JSON.parse(t); } catch { continue; }
      if (evt.error) { yield { type: "error", message: String(evt.error) }; return; }
      const msg = evt.message;
      if (msg?.content) { content += msg.content; yield { type: "text", text: msg.content }; }
      if (Array.isArray(msg?.tool_calls)) for (const tc of msg.tool_calls) toolCalls.push(tc);
      if (evt.done) {
        const s = (n: number) => ((n || 0) / 1e9).toFixed(1) + "s";
        console.log(`[ollama] ${model} prompt=${evt.prompt_eval_count}tok/${s(evt.prompt_eval_duration)} gen=${evt.eval_count}tok/${s(evt.eval_duration)} load=${s(evt.load_duration)} total=${s(evt.total_duration)} tools=${toolCalls.length}`);
        yield { type: "turn_end", content, toolCalls };
        return;
      }
    }
  }
  yield { type: "turn_end", content, toolCalls };
}

/** Stream a chat completion from Ollama, yielding the same StreamEvent shape
 *  the Anthropic path uses. Plain chat — no tool loop. */
export async function* streamChat(
  model: string,
  apiMessages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  maxTokens: number,
): AsyncGenerator<StreamEvent> {
  const host = ollamaHost();
  const messages = [{ role: "system", content: systemPrompt }, ...apiMessages];

  let response: Response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX },
      }),
    });
  } catch (err: any) {
    yield { type: "error", message: `Ollama unreachable at ${host}: ${err?.message || "error"}` };
    return;
  }
  if (!response.ok || !response.body) {
    yield { type: "error", message: `Ollama error ${response.status}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (evt.error) {
        yield { type: "error", message: String(evt.error) };
        return;
      }
      const chunk = evt?.message?.content;
      if (chunk) yield { type: "text_delta", text: chunk };
      if (evt.done) {
        yield { type: "done", message_id: crypto.randomUUID() };
        return;
      }
    }
  }
  yield { type: "done", message_id: crypto.randomUUID() };
}
