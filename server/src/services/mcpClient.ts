// Minimal MCP client for the loopback gateway (Streamable HTTP transport).
//
// The Maurice chat tool-loop uses this to list and call the household's MCP
// tools. Auth is the internal static key (MAURICE_MCP_TOKEN); member scope is
// passed per-call via the X-Maurice-Member-Id header, which the gateway's
// MemberContextMiddleware turns into the member_id contextvar.

import { getPort } from "../../data-api/lib/config";

const PROTOCOL_VERSION = "2025-03-26";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
}

function gatewayUrl(): string {
  const port = getPort("mcp-gateway");
  return `http://127.0.0.1:${port}/mcp`;
}

function authHeaders(memberId: string): Record<string, string> {
  const token = process.env.MAURICE_MCP_TOKEN || "";
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "X-Maurice-Member-Id": memberId,
  };
}

// Parse a Streamable-HTTP response body: either a JSON object, or SSE frames
// where the payload is on `data:` lines. Returns the first JSON-RPC message
// that has a `result` or `error`.
async function parseRpc(resp: Response): Promise<any> {
  const text = await resp.text();
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return JSON.parse(text);
  }
  // SSE: collect data: lines, parse each as JSON, return the one with id/result.
  let last: any = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const msg = JSON.parse(payload);
      if (msg.result !== undefined || msg.error !== undefined) return msg;
      last = msg;
    } catch {
      // ignore non-JSON keepalives
    }
  }
  return last;
}

/**
 * A short-lived MCP session: initialize once, then list/call tools.
 * Construct via McpSession.open(memberId).
 */
export class McpSession {
  private constructor(
    private memberId: string,
    private sessionId: string | null
  ) {}

  static async open(memberId: string): Promise<McpSession> {
    const headers = authHeaders(memberId);
    const resp = await fetch(gatewayUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "maurice-server", version: "0.1.0" },
        },
      }),
    });
    if (!resp.ok) {
      throw new Error(`MCP initialize failed: ${resp.status} ${await resp.text().catch(() => "")}`);
    }
    const sessionId = resp.headers.get("mcp-session-id");
    await parseRpc(resp); // drain initialize result

    const session = new McpSession(memberId, sessionId);
    // Required handshake: tell the server we're initialized.
    await session.notify("notifications/initialized");
    return session;
  }

  private headers(): Record<string, string> {
    const h = authHeaders(this.memberId);
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async notify(method: string): Promise<void> {
    await fetch(gatewayUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
    }).catch(() => {});
  }

  private async rpc(method: string, params: any, id: number): Promise<any> {
    const resp = await fetch(gatewayUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!resp.ok) {
      throw new Error(`MCP ${method} failed: ${resp.status} ${await resp.text().catch(() => "")}`);
    }
    const msg = await parseRpc(resp);
    if (msg?.error) {
      throw new Error(`MCP ${method} error: ${msg.error.message || JSON.stringify(msg.error)}`);
    }
    return msg?.result;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc("tools/list", {}, 2);
    return (result?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || t.input_schema || { type: "object" },
    }));
  }

  /** Call a tool; returns its content flattened to a string. */
  async callTool(name: string, args: any): Promise<{ text: string; isError: boolean }> {
    const result = await this.rpc("tools/call", { name, arguments: args || {} }, 3);
    const blocks = result?.content || [];
    const text = blocks
      .map((b: any) => (b?.type === "text" ? b.text : JSON.stringify(b)))
      .join("\n");
    return { text: text || "(no output)", isError: !!result?.isError };
  }
}

/** Convenience: list the member's tools in one shot. */
export async function listMemberTools(memberId: string): Promise<McpTool[]> {
  const s = await McpSession.open(memberId);
  return s.listTools();
}

/**
 * Call a corpus (or any gateway) tool scoped to `memberId` and parse its JSON
 * result. Used by the web admin for the Anthropic-export import flow.
 */
export async function corpusCall(memberId: string, name: string, args: any): Promise<any> {
  const s = await McpSession.open(memberId);
  // The gateway namespaces each sub-server's tools as `<server>__<tool>`.
  const toolName = name.includes("__") ? name : `corpus__${name}`;
  const { text, isError } = await s.callTool(toolName, args);
  if (isError) throw new Error(text || `${toolName} failed`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Fire-and-forget: ask the corpus tool to reconcile one conversation into the
 * per-member semantic index after a turn completes. The corpus fans out to every
 * participant itself, so a single call (scoped to any participant for gateway auth)
 * is enough. Never throws into the caller; the periodic backfill is the safety net.
 */
export function indexConversationInBackground(memberId: string, conversationId: string): void {
  McpSession.open(memberId)
    .then((s) => s.callTool("index_conversation", { conversation_id: conversationId }))
    .catch((err) =>
      console.warn(`[corpus] index_conversation(${conversationId}) failed: ${err?.message || err}`)
    );
}
