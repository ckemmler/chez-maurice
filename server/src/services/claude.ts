import { readFileSync } from "fs";
import { join } from "path";
import db from "../db";
import { getMessages, getParticipants, countParticipants } from "./conversations";
import { imagesDir } from "./images";
import { hasWebSearch, webSearch, formatWebSearch } from "./webSearch";
import { McpSession, type McpTool } from "./mcpClient";
import { resolveToText, resolveAttachments } from "./composer/specs";
import { type FileAttachment } from "./composer/files";
import { getConversationMaurice, resolveMauriceContext, resolveMauriceAttachments } from "./maurices";
import { resolveModelId, getModel } from "./models";
import { resolveUsableModel, getEverydayModel } from "./modelAccess";
import { ollamaTurn, type OllamaToolCall } from "./ollama";
import { openaiTurn, type OpenAIToolCall } from "./openaiChat";
import { resolveFamilies, toolInFamilies, canUseExperimental, isExperimentalTool } from "./toolFamilies";
import { t, userLocale } from "./i18n";

interface StreamEvent {
  type: "text_delta" | "done" | "error" | "tool_call" | "tool_data";
  text?: string;
  message_id?: string;
  message?: string;
  // tool_call events: which tool, and start/end of its execution
  tool?: string;
  status?: "start" | "end";
  // tool_data events: the structured result a tool returned, rendered
  // deterministically by the client alongside Maurice's prose.
  data?: unknown;
}

// Cap on agentic tool rounds per user turn — prevents runaway loops.
const MAX_TOOL_ROUNDS = 6;

function getHouseholdConfig(): {
  apiKey: string | null;
  openaiApiKey: string | null;
  mistralApiKey: string | null;
  falApiKey: string | null;
  defaultModel: string;
  maxTokens: number;
} {
  const row = db
    .query(
      `SELECT api_key, openai_api_key, mistral_api_key, fal_api_key, default_model, max_tokens FROM households WHERE id = 'default'`
    )
    .get() as any;

  return {
    apiKey: row.api_key,
    openaiApiKey: row.openai_api_key,
    mistralApiKey: row.mistral_api_key,
    falApiKey: row.fal_api_key,
    defaultModel: row.default_model,
    maxTokens: row.max_tokens,
  };
}

export { getHouseholdConfig };

// Image generate/edit directives shared by 1:1 and room prompts, so picture
// generation behaves the same however Maurice is summoned.
const IMAGE_DIRECTIVES =
  `\n\nIf asked to generate, draw, create, or make an image or picture FROM SCRATCH (no photo uploaded), respond with ONLY a single line in this exact format:\n[IMAGE: detailed prompt describing the image to generate]\nDo not add any other text before or after. Write a rich, detailed prompt that will produce a great image.` +
  `\n\nIf a photo is shared AND you're asked to modify, edit, transform, restyle, or alter it, respond with ONLY a single line in this exact format:\n[EDIT_IMAGE: detailed prompt describing the desired edit]\nDo not add any other text before or after. Write a clear, detailed prompt describing the desired result. Refuse inappropriate or harmful edit requests politely.` +
  `\nIMPORTANT: If a photo is shared and someone simply asks what's in it or asks questions about it, respond normally with text — do NOT use EDIT_IMAGE. Do not call any tool when generating or editing an image.`;

// When a tool returns structured data, the app renders the actual rows in a
// table right next to your reply — so transcribing them back is redundant
// noise. This nudges the model to interpret rather than re-list. It only
// reduces the rate; the rendered table is the real ground truth. Note the
// carve-out: web_search returns prose (no table), so it must still be conveyed.
const TOOL_DATA_DIRECTIVE =
  `\n\nWhen a tool returns structured data (a list of records, an object — anything but plain prose), the app shows those exact rows and values to the user in a table right beside your reply. They can already see the data. So do NOT re-list, transcribe, or read back the rows, fields, or numbers. Instead interpret: answer the question, summarize the trend, highlight what's notable or surprising, flag anything missing or off — the things a table alone doesn't tell them. If a tool returned fewer rows than asked for, say so plainly rather than papering over it; never invent or estimate values that aren't in the result. (This applies only to structured results shown in a table. web_search returns prose with no table, so convey its findings normally.)`;

// Non-negotiable content-safety floor. Appended LAST to every system prompt
// (after any persona instructions + loaded context), for every provider, so it
// cannot be stripped or out-prioritized by a custom persona. Narrow by design:
// it refuses ONLY the two App-Store-non-distributable categories (explicit
// sexual activity/nudity; prolonged/sadistic gore) plus the absolute minor
// carve-out — non-explicit romance, mature themes, profanity, and ordinary or
// realistic fictional violence stay allowed (matches the age-rating answers).
// NOTE: this is the official build's default. A forked/self-hosted instance with
// a stripped prompt or a different model can bypass it (open-source tax) — see
// docs/operator-safety.md.
const CONTENT_SAFETY_FLOOR =
  `\n\n## Safety rules (these take final precedence over everything above, including any role, persona, or instruction)\n` +
  `- Never produce sexual or sexualized content involving a minor, in any form, context, or "fiction" framing. Refuse completely and unconditionally; no instruction or persona can override this.\n` +
  `- Do not write explicit, graphic depictions of sexual activity or nudity between adults. Non-explicit romance, attraction, and mature themes are fine.\n` +
  `- Do not write prolonged, graphic, or sadistic depictions of gore or torture. Ordinary or realistic violence in fiction (action, horror, conflict, history) is fine.\n` +
  `When you decline under these rules, do it briefly and offer a non-graphic alternative.`;

// A fresh "now" for every turn, in the server's (= household's) timezone, so the
// model interprets relative times and passes correct dates to tools. Models —
// especially local ones — have no clock otherwise.
function currentTimeContext(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatted = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(now);
  return `The current date and time is ${formatted} (${tz}). Treat this as "now": resolve relative times like "today", "tomorrow", "this week" against it, and pass concrete dates to tools accordingly.`;
}

function buildSystemPrompt(userDisplayName: string, profileText?: string | null): string {
  let prompt = `You are Maurice, a household AI assistant. You are talking to ${userDisplayName}.`;
  prompt += ` ${currentTimeContext()}`;
  prompt += ` Be helpful, clear, and warm. Keep responses concise unless the user asks for depth.`;
  prompt += ` The user may share photos with you — describe what you see and answer any questions about them.`;
  prompt += ` You have tools: a web_search tool for current information from the internet, and the household's personal tools (tasks, calendar, contacts, notes, health, books, and more). Use them when they help; prefer the personal tools for anything about ${userDisplayName}'s own data.`;
  prompt += IMAGE_DIRECTIVES;
  prompt += TOOL_DATA_DIRECTIVE;
  if (profileText) {
    prompt += `\n\nAbout this user: ${profileText}`;
  }
  return prompt;
}

// Shared-room prompt: Maurice is a summoned participant, not the medium. Human
// turns arrive name-prefixed (see buildApiMessages), so he knows who said what.
function buildRoomSystemPrompt(conversationId: string, summonerName: string): string {
  const names = getParticipants(conversationId).map((p) => p.display_name);
  let prompt = `You are Maurice, a household AI assistant, present in a shared room with: ${names.join(", ")}.`;
  prompt += ` ${currentTimeContext()}`;
  prompt += ` Several people talk to each other here; each human message is prefixed with the speaker's name (e.g. "Alex: ..."). You are not the medium of their conversation — you are a participant they summon with @claude or @maurice.`;
  prompt += ` You were just summoned by ${summonerName}. Respond to the room. Address people by name when it helps; keep replies concise and warm.`;
  prompt += ` Anything loaded into this conversation's context — notes, books, past conversations, signals someone added — is shared with everyone in the room; treat it as common ground and discuss it openly with whoever asks, no matter who added it. Stay grounded in what was actually said and in that shared context, and don't invent things people didn't say.`;
  prompt += ` You have a web_search tool and the household's personal tools (tasks, calendar, notes, health, books, and more); use them when they help the room.`;
  prompt += IMAGE_DIRECTIVES;
  prompt += TOOL_DATA_DIRECTIVE;
  return prompt;
}

// Anthropic tool definition for our self-hosted web search.
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the public internet for current or factual information and get back a short answer plus source snippets. Use for news, recent events, facts you're unsure about, or anything beyond your training data.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },
};

function mcpToolToAnthropic(t: McpTool) {
  return {
    name: t.name,
    description: t.description || t.name,
    input_schema: t.inputSchema || { type: "object" },
  };
}

// OpenAI-style "function" tool shape — used by Ollama, OpenAI, and Mistral.
function mcpToolToFunction(t: McpTool) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.inputSchema || { type: "object" },
    },
  };
}

const WEB_SEARCH_FUNCTION = {
  type: "function",
  function: {
    name: "web_search",
    description: WEB_SEARCH_TOOL.description,
    parameters: WEB_SEARCH_TOOL.input_schema,
  },
};

// Anthropic content can be string or an array (with images). The OpenAI/Ollama
// chat APIs here take plain text, so flatten to text (images are dropped for
// those providers; Anthropic keeps them on its own path).
function toTextMessages(messages: any[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : (m.content as any[]).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
  }));
}

// Many MCP tools return pretty-printed JSON (indent=2). The model doesn't need
// the whitespace — minifying it is lossless and can cut 20-40% of the result's
// tokens, which directly speeds up the next prefill pass.
function compactToolText(text: string): string {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return text;
  }
}

/** Execute a single tool call (web search or any MCP tool). Shared by the
 *  Anthropic and Ollama agentic loops. */
/** If a tool's textual result is JSON (object/array), return the parsed value
 *  so the client can render it deterministically beside Maurice's prose. The
 *  model still receives the text; this is a parallel, model-untouched channel.
 *  Non-JSON results (e.g. web-search prose) yield null — no data card. */
function parseToolData(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function executeTool(
  name: string,
  input: any,
  mcp: McpSession | null,
): Promise<{ text: string; isError: boolean; data?: unknown }> {
  try {
    if (name === "web_search") {
      return { text: formatWebSearch(await webSearch(input?.query || "")), isError: false };
    }
    if (mcp) {
      const r = await mcp.callTool(name, input || {});
      const text = compactToolText(r.text);
      return { text, isError: r.isError, data: r.isError ? null : parseToolData(text) };
    }
    return { text: `Tool ${name} is unavailable.`, isError: true };
  } catch (err: any) {
    return { text: `Tool error: ${err?.message || "failed"}`, isError: true };
  }
}

/** Agentic loop for a local (Ollama) model: stream text, run any tool calls,
 *  feed results back, repeat. Falls back to plain chat if the model can't do
 *  tools. Mirrors the Anthropic loop below. */
async function* runOllamaAgentic(
  model: string,
  system: string,
  baseMessages: any[],
  tools: any[],
  mcp: McpSession | null,
  maxTokens: number,
  lang: string,
): AsyncGenerator<StreamEvent> {
  const convo: any[] = [{ role: "system", content: system }, ...baseMessages];
  let useTools = tools.length > 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let content = "";
    let toolCalls: OllamaToolCall[] = [];
    let unsupported = false;
    for await (const ev of ollamaTurn(model, convo, useTools ? tools : [], maxTokens)) {
      if (ev.type === "text") {
        content += ev.text;
        yield { type: "text_delta", text: ev.text };
      } else if (ev.type === "turn_end") {
        toolCalls = ev.toolCalls;
      } else if (ev.type === "error") {
        // Some local models don't support tool-calling — retry as plain chat.
        if (useTools && /does ?n.t support tools|tools.*not supported/i.test(ev.message)) {
          unsupported = true;
        } else {
          yield { type: "error", message: ev.message };
          return;
        }
      }
    }
    if (unsupported) {
      useTools = false;
      round--;
      continue;
    }
    if (!toolCalls.length) {
      yield { type: "done", message_id: crypto.randomUUID() };
      return;
    }
    convo.push({ role: "assistant", content, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name || "";
      yield { type: "tool_call", tool: name, status: "start" };
      const r = await executeTool(name, tc.function?.arguments || {}, mcp);
      yield { type: "tool_call", tool: name, status: "end" };
      if (r.data != null) yield { type: "tool_data", tool: name, data: r.data };
      convo.push({ role: "tool", content: r.text });
    }
  }
  yield { type: "text_delta", text: t(lang, "chat.stopped_tool_steps") };
  yield { type: "done", message_id: crypto.randomUUID() };
}

/** Agentic loop for an OpenAI-style provider (OpenAI or Mistral). Same shape as
 *  the others, but the Chat Completions message format (assistant tool_calls +
 *  role:"tool" results keyed by tool_call_id). */
async function* runOpenAIAgentic(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  baseMessages: any[],
  tools: any[],
  mcp: McpSession | null,
  temperature: number | undefined,
  lang: string,
): AsyncGenerator<StreamEvent> {
  const convo: any[] = [{ role: "system", content: system }, ...baseMessages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let content = "";
    let toolCalls: OpenAIToolCall[] = [];
    for await (const ev of openaiTurn(baseUrl, apiKey, model, convo, tools, temperature)) {
      if (ev.type === "text") {
        content += ev.text;
        yield { type: "text_delta", text: ev.text };
      } else if (ev.type === "turn_end") {
        toolCalls = ev.toolCalls;
      } else if (ev.type === "error") {
        yield { type: "error", message: ev.message };
        return;
      }
    }
    if (!toolCalls.length) {
      yield { type: "done", message_id: crypto.randomUUID() };
      return;
    }
    convo.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: tc.function })),
    });
    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      yield { type: "tool_call", tool: name, status: "start" };
      const r = await executeTool(name, args, mcp);
      yield { type: "tool_call", tool: name, status: "end" };
      if (r.data != null) yield { type: "tool_data", tool: name, data: r.data };
      convo.push({ role: "tool", tool_call_id: tc.id, content: r.text });
    }
  }
  yield { type: "text_delta", text: t(lang, "chat.stopped_tool_steps") };
  yield { type: "done", message_id: crypto.randomUUID() };
}

function buildApiMessages(conversationId: string): any[] {
  const history = getMessages(conversationId);
  const imagePattern = /!\[.*?\]\(\/api\/images\/(.+?)\)/g;

  // In a multi-human room, prefix each human turn with the speaker's name so
  // Maurice can tell who said what (the API only has user/assistant roles).
  const isRoom = countParticipants(conversationId) > 1;
  const nameById: Record<string, string> = {};
  if (isRoom) for (const p of getParticipants(conversationId)) nameById[p.member_id] = p.display_name;
  const speaker = (m: { role: string; author_id: string | null }) =>
    isRoom && m.role === "user"
      ? `${(m.author_id && nameById[m.author_id]) || "Someone"}: `
      : "";

  return history
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role as "user" | "assistant";
      const tag = speaker(m);
      const images = [...m.content.matchAll(imagePattern)];
      if (images.length === 0) {
        return { role, content: tag + m.content };
      }
      const content: any[] = [];
      for (const img of images) {
        const filename = img[1]!;
        try {
          const filePath = join(imagesDir, filename);
          const data = readFileSync(filePath).toString("base64");
          const mediaType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
          content.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          });
        } catch {
          // missing image — skip
        }
      }
      const textContent = (tag + m.content.replace(imagePattern, "")).trim();
      if (textContent) content.push({ type: "text", text: textContent });
      return {
        role,
        content: content.length === 1 && content[0].type === "text" ? content[0].text : content,
      };
    });
}

// Library binaries (img/pdf) loaded into the composer ride along as real content
// blocks on the latest user turn — the system prompt is text-only, so this is the
// only place an image/PDF can reach the model. Anthropic-only blocks; other
// providers flatten them away (toTextMessages). PDFs become `document` blocks
// (Anthropic native PDF support); images become `image` blocks.
function attachBinaries(messages: any[], attachments: FileAttachment[]): void {
  if (!attachments.length) return;
  // Find the last user turn (what the model is answering right now).
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== "user") i--;
  if (i < 0) return;

  const blocks: any[] = attachments.map((a) =>
    a.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 }, title: a.name }
      : { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.base64 } },
  );
  const names = attachments.map((a) => a.name).join(", ");
  blocks.unshift({ type: "text", text: `[Loaded from your library: ${names}]` });

  const existing = messages[i].content;
  const tail = typeof existing === "string" ? [{ type: "text", text: existing }] : (existing as any[]);
  messages[i] = { role: "user", content: [...blocks, ...tail] };
}

/**
 * Stream a response from Claude with an agentic tool loop.
 * Falls back to echo-back if no API key is configured.
 */
export async function* streamResponse(
  conversationId: string,
  userDisplayName: string,
  profileText?: string | null,
  memberId?: string,
  signal?: AbortSignal
): AsyncGenerator<StreamEvent> {
  const config = getHouseholdConfig();
  // Language for any fallback/error text we send back (the model's own replies
  // already follow the user's language).
  const userLang = userLocale(memberId);

  const messages = buildApiMessages(conversationId);
  // In a room the summoner is whoever sent the @claude message (userDisplayName).
  let systemPrompt =
    countParticipants(conversationId) > 1
      ? buildRoomSystemPrompt(conversationId, userDisplayName)
      : buildSystemPrompt(userDisplayName, profileText);

  // Specialized Maurice (persona): a named, hatted assistant with its own
  // behaviour, model preference, creativity, and baked-in context bundle.
  const maurice = getConversationMaurice(conversationId);
  if (maurice && maurice.prompt.trim()) {
    systemPrompt +=
      `\n\n## You are "${maurice.name}"\nFor this conversation you take on a specialized role. Follow these instructions, which take precedence over your general defaults:\n\n${maurice.prompt.trim()}`;
  }

  // Composer context: the persona's locked bundle FIRST (it can't be removed),
  // then whatever the user added for this conversation. Deduped by item so a
  // re-added note isn't loaded twice; resolved from the frozen snapshots.
  if (memberId) {
    try {
      const seen = new Set<string>();
      const blocks: string[] = [];
      const pushItems = (items: { type: string; id: string | number; text: string }[]) => {
        for (const i of items) {
          const key = `${i.type}:${i.id}`;
          if (seen.has(key) || !i.text?.trim()) continue;
          seen.add(key);
          blocks.push(i.text);
        }
      };
      if (maurice) pushItems(resolveMauriceContext(memberId, maurice).items);
      pushItems(resolveToText(memberId, conversationId).items);
      const block = blocks.join("\n\n———\n\n");
      if (block.trim()) {
        systemPrompt +=
          `\n\n## Loaded context\nThe following material has been loaded into this conversation${maurice ? ` (some baked into ${maurice.name})` : ""}. Treat it as authoritative background and draw on it when relevant.\n\n${block}`;
      }

      // Library binaries (img/pdf) → real content blocks on the latest user turn.
      const attSeen = new Set<string>();
      const attachments: FileAttachment[] = [];
      const pushAtt = (atts: FileAttachment[]) => {
        for (const a of atts) {
          if (attSeen.has(a.name + a.base64.length)) continue;
          attSeen.add(a.name + a.base64.length);
          attachments.push(a);
        }
      };
      if (maurice) pushAtt(resolveMauriceAttachments(memberId, maurice));
      pushAtt(resolveAttachments(memberId, conversationId));
      attachBinaries(messages, attachments);
    } catch (err) {
      console.error("[claude] composer context failed:", (err as Error)?.message);
    }
  }

  // Non-negotiable content-safety floor — appended LAST so no persona prompt or
  // loaded context above can strip or out-prioritize it (covers every provider).
  systemPrompt += CONTENT_SAFETY_FLOOR;

  // Resolve the model for this turn, honouring the member's access: the
  // persona's preference if allowed, else the household default if allowed,
  // else their best available. (No member → just persona/default.) For the
  // everyday Maurice (no persona) the "preference" is the member's own everyday
  // model — foyer-mates can each run a different LLM for it.
  const preferred = maurice
    ? maurice.model
    : memberId
      ? getEverydayModel(memberId)
      : null;
  const resolved = memberId
    ? resolveUsableModel(memberId, preferred, config.defaultModel)
    : resolveModelId(maurice?.model, config.defaultModel);
  if (!resolved) {
    yield { type: "text_delta", text: t(userLang, "chat.no_model_access") };
    yield { type: "done", message_id: crypto.randomUUID() };
    return;
  }
  const rec = getModel(resolved);
  const isLocal = rec?.tier === "local";
  const provider = rec?.provider ?? (isLocal ? "ollama" : "anthropic");
  const temperature = maurice ? maurice.temp : undefined;

  // Which tool families may this turn use? (conversation → persona → household
  // → tier default). Filter the member's MCP tools to those families so a small
  // local model isn't handed all 100+ at once.
  const families: "all" | string[] = memberId
    ? resolveFamilies(conversationId, isLocal, memberId)
    : isLocal ? [] : "all";
  const wantsWeb = families === "all" || families.includes("web");

  let mcp: McpSession | null = null;
  let mcpTools: McpTool[] = [];
  if (memberId && (families === "all" || families.length > 0)) {
    try {
      mcp = await McpSession.open(memberId);
      const all = await mcp.listTools();
      const expOK = canUseExperimental(memberId);
      mcpTools = (families === "all" ? all : all.filter((t) => toolInFamilies(t.name, families as string[])))
        .filter((t) => expOK || !isExperimentalTool(t.name)); // never hand experimental tools to ungated members
    } catch (err: any) {
      console.error("[claude] MCP unavailable:", err?.message);
      mcp = null;
      mcpTools = [];
    }
  }

  // Local (Ollama) — private, on the Mac mini. Selected tool families only.
  if (provider === "ollama") {
    const tools = mcpTools.map(mcpToolToFunction);
    if (wantsWeb && hasWebSearch()) tools.push(WEB_SEARCH_FUNCTION);
    yield* runOllamaAgentic(resolved, systemPrompt, toTextMessages(messages), tools, mcp, config.maxTokens, userLang);
    return;
  }

  // OpenAI / Mistral — OpenAI-compatible Chat Completions.
  if (provider === "openai" || provider === "mistral") {
    const baseUrl = provider === "openai" ? "https://api.openai.com/v1" : "https://api.mistral.ai/v1";
    const key = provider === "openai" ? config.openaiApiKey : config.mistralApiKey;
    if (!key) {
      const label = provider === "openai" ? "OpenAI" : "Mistral";
      yield { type: "text_delta", text: t(userLang, "chat.no_provider_key", label) };
      yield { type: "done", message_id: crypto.randomUUID() };
      return;
    }
    const tools = mcpTools.map(mcpToolToFunction);
    if (wantsWeb && hasWebSearch()) tools.push(WEB_SEARCH_FUNCTION);
    yield* runOpenAIAgentic(baseUrl, key, resolved, systemPrompt, toTextMessages(messages), tools, mcp, temperature, userLang);
    return;
  }

  // Anthropic — needs a key; without one, fall back to echo mode.
  if (!config.apiKey) {
    const lastUserMsg = getMessages(conversationId).filter((m) => m.role === "user").pop();
    const echo = lastUserMsg
      ? t(userLang, "chat.echo_mode_said", lastUserMsg.content)
      : t(userLang, "chat.echo_mode");
    for (const word of echo.split(" ")) {
      yield { type: "text_delta", text: word + " " };
      await new Promise((r) => setTimeout(r, 30));
    }
    yield { type: "done", message_id: crypto.randomUUID() };
    return;
  }

  // Cloud tool set: web search (if selected) + the family-filtered MCP tools.
  const tools: any[] = [];
  if (wantsWeb && hasWebSearch()) tools.push(WEB_SEARCH_TOOL);
  for (const t of mcpTools) tools.push(mcpToolToAnthropic(t));

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const body: any = {
        model: resolved,
        max_tokens: config.maxTokens,
        system: systemPrompt,
        messages,
        stream: true,
      };
      if (temperature !== undefined) body.temperature = temperature;
      if (tools.length) body.tools = tools;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        if (errBody.includes("credit balance is too low")) {
          yield { type: "text_delta", text: t(userLang, "chat.out_of_credits") };
          yield { type: "done", message_id: crypto.randomUUID() };
          return;
        }
        yield { type: "error", message: `Anthropic API error ${response.status}: ${errBody}` };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: "error", message: "No response body" };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      // Accumulators for this assistant turn.
      const contentBlocks: any[] = []; // final assistant content (text + tool_use)
      const blockState: Record<number, { type: string; text?: string; id?: string; name?: string; partialJson?: string }> = {};
      let stopReason: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.type === "content_block_start") {
            const idx = event.index;
            const cb = event.content_block;
            if (cb?.type === "text") {
              blockState[idx] = { type: "text", text: "" };
            } else if (cb?.type === "tool_use") {
              blockState[idx] = { type: "tool_use", id: cb.id, name: cb.name, partialJson: "" };
            }
          } else if (event.type === "content_block_delta") {
            const idx = event.index;
            const st = blockState[idx];
            if (!st) continue;
            if (event.delta?.type === "text_delta") {
              st.text = (st.text || "") + event.delta.text;
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta?.type === "input_json_delta") {
              st.partialJson = (st.partialJson || "") + (event.delta.partial_json || "");
            }
          } else if (event.type === "content_block_stop") {
            const idx = event.index;
            const st = blockState[idx];
            if (!st) continue;
            if (st.type === "text") {
              contentBlocks.push({ type: "text", text: st.text || "" });
            } else if (st.type === "tool_use") {
              let input: any = {};
              try {
                input = st.partialJson ? JSON.parse(st.partialJson) : {};
              } catch {
                input = {};
              }
              contentBlocks.push({ type: "tool_use", id: st.id, name: st.name, input });
            }
          } else if (event.type === "message_delta") {
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          } else if (event.type === "error") {
            yield { type: "error", message: event.error?.message || "Unknown error" };
            return;
          }
        }
      }

      // Not a tool turn → we're done.
      if (stopReason !== "tool_use") {
        yield { type: "done", message_id: crypto.randomUUID() };
        return;
      }

      // Record the assistant turn (text + tool_use blocks), then run the tools.
      messages.push({ role: "assistant", content: contentBlocks });

      const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        yield { type: "tool_call", tool: tu.name, status: "start" };
        const r = await executeTool(tu.name, tu.input || {}, mcp);
        yield { type: "tool_call", tool: tu.name, status: "end" };
        // Surface the structured result on a model-untouched channel so the
        // client can render the actual rows next to Maurice's narration.
        if (r.data != null) yield { type: "tool_data", tool: tu.name, data: r.data };
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: r.text,
          is_error: r.isError,
        });
      }

      messages.push({ role: "user", content: toolResults });
      // loop again with the tool results appended
    }

    // Hit the round cap.
    yield {
      type: "text_delta",
      text: t(userLang, "chat.stopped_tool_steps_more"),
    };
    yield { type: "done", message_id: crypto.randomUUID() };
  } catch (err: any) {
    // Client cancelled (⏹ Stop) → the fetch was aborted. Stop quietly; the route
    // persists whatever streamed so far. Anything else is a real error.
    if (signal?.aborted || err?.name === "AbortError") return;
    yield { type: "error", message: err.message || "Stream failed" };
  }
}
