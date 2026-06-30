import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  listConversations,
  getConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  getMessages,
  addMessage,
  autoTitle,
  deleteLastAssistantMessage,
  getParticipants,
  addParticipant,
  removeParticipant,
  countParticipants,
  setConversationToolFamilies,
  conversationToolFamiliesOverride,
  markConversationRead,
  setConversationMaurice,
} from "../services/conversations";
import { getUser, getUserByUsername, guestCanReach } from "../services/users";
import { blockedIdsFor, createReport, isReason, hasBlocked } from "../services/safety";
import { streamResponse, getHouseholdConfig } from "../services/claude";
import { getConversationMaurice, canUseMaurice } from "../services/maurices";
import { resolveUsableModel } from "../services/modelAccess";
import { getModel, householdDefaultModel } from "../services/models";
import { resolveFamilies, listFamilies } from "../services/toolFamilies";
import { generateImage, editImage, saveUploadedImage, loadImageAsDataUri } from "../services/images";
import { publishToRoom, publishToUser, userHasSocket } from "../services/roomBus";
import { pushToUser } from "../services/push";
import { indexConversationInBackground } from "../services/mcpClient";

const conversations = new Hono();

conversations.use("/*", requireAuth);

// Maurice is summoned in a multi-human room only when explicitly mentioned;
// in a 1:1 chat (single participant) every message is for him.
const SUMMON_RE = /(^|[^a-z0-9_])@(claude|maurice)\b/i;
function mentionsMaurice(text: string): boolean {
  return SUMMON_RE.test(text);
}

/** A short, image-stripped preview for notifications. */
function preview(content: string): string {
  const t = content.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}

/** Notify every participant except `excludeId` about room activity, on their
 *  global socket → unread badge + a system notification. */
function notifyActivity(
  conversationId: string,
  excludeId: string | null,
  payload: { title: string; author: string; preview: string },
): void {
  for (const p of getParticipants(conversationId)) {
    if (p.member_id === excludeId) continue;
    publishToUser(p.member_id, { type: "activity", conversationId, ...payload });
    const hasSock = userHasSocket(p.member_id);
    console.log(`[push] activity convo=${conversationId} member=${p.member_id} hasSocket=${hasSock}`);
    // No live socket → the app can't show a local notification, so push instead.
    if (!hasSock) {
      void pushToUser(p.member_id, {
        title: payload.title || payload.author,
        body: `${payload.author}: ${payload.preview}`,
        conversationId,
      });
    }
  }
}

// ── GET /api/conversations ──────────────────────────────────────

conversations.get("/", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "40", 10);
  const list = listConversations(c.get("userId"), {
    limit: Number.isFinite(limit) ? limit : 40,
    beforeAt: c.req.query("before_at") || undefined,
    beforeId: c.req.query("before_id") || undefined,
  });
  return c.json(list);
});

// ── POST /api/conversations ─────────────────────────────────────

conversations.post("/", async (c) => {
  const { maurice_id } = await c.req.json().catch(() => ({}));
  const uid = c.get("userId");
  // A Maurice is private to its creator — can't bind a thread to someone else's.
  if (!canUseMaurice(maurice_id ?? null, uid)) return c.json({ error: "Not found" }, 404);
  const convo = createConversation(uid, maurice_id ?? null);
  return c.json(convo, 201);
});

// ── GET /api/conversations/:id ──────────────────────────────────

conversations.get("/:id", (c) => {
  const convo = getConversation(c.req.param("id"), c.get("userId"));
  if (!convo) return c.json({ error: "Not found" }, 404);

  // Server-side block enforcement: hide messages authored by anyone the viewer
  // has blocked. (Block is member↔member; it is not protection from a hostile
  // operator — see RELEASING/safety docs.)
  const blocked = blockedIdsFor(c.get("userId"));
  const messages = getMessages(convo.id).filter(
    (m) => !m.author_id || !blocked.has(m.author_id),
  );
  const participants = getParticipants(convo.id);
  return c.json({ ...convo, messages, participants });
});

// ── POST /api/conversations/:id/read — mark read (drives unread roll-up) ──

conversations.post("/:id/read", (c) => {
  markConversationRead(c.get("userId"), c.req.param("id"));
  return c.json({ ok: true });
});

// ── PATCH /api/conversations/:id/maurice — arm the thread's current Maurice ──
// (the 🎩 picker, without sending). maurice_id null = everyday.

conversations.patch("/:id/maurice", async (c) => {
  const { maurice_id } = await c.req.json().catch(() => ({}));
  const uid = c.get("userId");
  if (!canUseMaurice(maurice_id ?? null, uid)) return c.json({ error: "Not found" }, 404);
  const ok = setConversationMaurice(c.req.param("id"), uid, maurice_id ?? null);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Participants: who is in the room ────────────────────────────

conversations.get("/:id/participants", (c) => {
  const convo = getConversation(c.req.param("id"), c.get("userId"));
  if (!convo) return c.json({ error: "Not found" }, 404);
  return c.json(getParticipants(convo.id));
});

// Add a member to the room (by username or member id). Any participant may
// invite — presence is how the commons lineage will later be earned.
conversations.post("/:id/participants", async (c) => {
  const convo = getConversation(c.req.param("id"), c.get("userId"));
  if (!convo) return c.json({ error: "Not found" }, 404);

  const { username, member_id } = await c.req.json().catch(() => ({}));
  const target = member_id ? getUser(member_id) : username ? getUserByUsername(username) : null;
  if (!target) return c.json({ error: "Unknown member" }, 404);

  // A guest may only share a room with people on their allow-list. Check the new
  // member against everyone already here (covers both "target is a guest" and
  // "an existing participant is a guest").
  for (const p of getParticipants(convo.id)) {
    if (!guestCanReach(target.id, p.member_id)) {
      return c.json({ error: "Not allowed to add this member" }, 403);
    }
  }

  // A blocked member can't pull the blocker into a room: if the person being
  // added has blocked the caller, refuse (the blocked member is initiating
  // contact with the blocker).
  if (hasBlocked(target.id, c.get("userId"))) {
    return c.json({ error: "Not allowed to add this member" }, 403);
  }

  addParticipant(convo.id, target.id, "member");
  const participants = getParticipants(convo.id);
  publishToRoom(convo.id, { type: "participants", participants });
  // Tell the newly added member's global socket so the conversation shows up in
  // their list live (and they get a notification) without a refresh.
  const by = getUser(c.get("userId"))?.display_name ?? "Someone";
  publishToUser(target.id, {
    type: "conversation_added",
    conversationId: convo.id,
    title: convo.title ?? "",
    by,
  });
  if (!userHasSocket(target.id)) {
    void pushToUser(target.id, {
      title: convo.title || "New conversation",
      body: `${by} added you to a conversation`,
      conversationId: convo.id,
    });
  }
  return c.json(participants, 201);
});

conversations.delete("/:id/participants/:memberId", (c) => {
  const convo = getConversation(c.req.param("id"), c.get("userId"));
  if (!convo) return c.json({ error: "Not found" }, 404);
  removeParticipant(convo.id, c.req.param("memberId"));
  const participants = getParticipants(convo.id);
  publishToRoom(convo.id, { type: "participants", participants });
  return c.json(participants);
});

// ── POST /api/conversations/:id/leave — leave a room (self) ──────

conversations.post("/:id/leave", (c) => {
  const convo = getConversation(c.req.param("id"), c.get("userId"));
  if (!convo) return c.json({ error: "Not found" }, 404);
  removeParticipant(convo.id, c.get("userId"));
  publishToRoom(convo.id, { type: "participants", participants: getParticipants(convo.id) });
  return c.json({ ok: true });
});

// ── POST /api/conversations/:id/reports — report room content ────
// Member↔member moderation for the household operator. Only valid in a shared
// room (>1 participant); private 1:1 can never be reported.

conversations.post("/:id/reports", async (c) => {
  const convo = getConversation(c.req.param("id"), c.get("userId"));
  if (!convo) return c.json({ error: "Not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    target_type?: string;
    target_id?: string;
    reason?: string;
    note?: string;
  };
  if (body.target_type !== "message" && body.target_type !== "member") {
    return c.json({ error: "target_type must be 'message' or 'member'" }, 400);
  }
  if (!body.target_id || typeof body.target_id !== "string") {
    return c.json({ error: "target_id required" }, 400);
  }
  if (!isReason(body.reason)) {
    return c.json({ error: "invalid reason" }, 400);
  }
  const report = createReport({
    reporterId: c.get("userId"),
    roomId: convo.id,
    targetType: body.target_type,
    targetId: body.target_id,
    reason: body.reason,
    note: typeof body.note === "string" ? body.note : null,
  });
  // Null = not a shared room, target not in this room, or reporter not a member.
  if (!report) return c.json({ error: "Cannot report this content" }, 400);
  return c.json({ ok: true, report_id: report.id }, 201);
});

// ── PATCH /api/conversations/:id ────────────────────────────────

conversations.patch("/:id", async (c) => {
  const { title } = await c.req.json();
  if (!title) return c.json({ error: "title required" }, 400);

  const convo = renameConversation(
    c.req.param("id"),
    c.get("userId"),
    title
  );
  if (!convo) return c.json({ error: "Not found" }, 404);
  return c.json(convo);
});

// ── Tool families for this conversation ─────────────────────────
// GET → the effective set (resolved) + whether it's an explicit override.
conversations.get("/:id/tool-families", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  if (!getConversation(id, userId)) return c.json({ error: "Not found" }, 404);
  // Determine the conversation's model tier so the "all"/none default matches.
  const maurice = getConversationMaurice(id);
  const model = resolveUsableModel(userId, maurice?.model ?? null, householdDefaultModel());
  const isLocal = model ? getModel(model)?.tier === "local" : false;
  const resolved = resolveFamilies(id, isLocal, userId);
  const all = resolved === "all";
  const selected = all ? (await listFamilies(userId)).map((f) => f.id) : (resolved as string[]);
  return c.json({
    selected,
    all,
    overridden: conversationToolFamiliesOverride(id) !== null,
  });
});

// PATCH → set (or clear by omitting `families`) the per-conversation override.
conversations.patch("/:id/tool-families", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { families?: string[] | null };
  const families = body.families === undefined ? null : body.families;
  const ok = setConversationToolFamilies(id, c.get("userId"), families);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── DELETE /api/conversations/:id ───────────────────────────────

conversations.delete("/:id", (c) => {
  const ok = deleteConversation(c.req.param("id"), c.get("userId"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── POST /api/conversations/:id/messages ────────────────────────
// Send a message and stream Maurice's response.
// Returns newline-delimited JSON events.

conversations.post("/:id/messages", async (c) => {
  const convoId = c.req.param("id");
  const userId = c.get("userId");

  const convo = getConversation(convoId, userId);
  if (!convo) return c.json({ error: "Not found" }, 404);

  const reqBody = await c.req.json().catch(() => ({}) as any);
  const { content, image, regenerate } = reqBody;
  // Content-first summon: ➤ sends { summon: true, maurice_id: <armed> }, 💬 sends
  // { summon: false }. `maurice_id` (when present, null = everyday) arms the
  // thread's current Maurice. Falls back to the legacy heuristic for old clients.
  const summonFlag: boolean | undefined =
    typeof reqBody.summon === "boolean" ? reqBody.summon : undefined;
  const armedMaurice: string | null | undefined =
    "maurice_id" in reqBody ? (reqBody.maurice_id ?? null) : undefined;
  if (armedMaurice !== undefined) {
    // Private to its creator — refuse to arm a thread with someone else's Maurice.
    if (!canUseMaurice(armedMaurice, userId)) return c.json({ error: "Not found" }, 404);
    setConversationMaurice(convoId, userId, armedMaurice);
  }
  const summonedMaurice: string | null =
    armedMaurice !== undefined ? armedMaurice : (convo.maurice_id ?? null);

  if (regenerate) {
    // Re-answer: drop the previous assistant message and stream a fresh
    // response from the existing history (which now ends at the last user
    // message). No new user message is added.
    deleteLastAssistantMessage(convoId);
  } else {
    if (!content?.trim() && !image) {
      return c.json({ error: "content required" }, 400);
    }

    // If an image was attached, save it and build markdown content
    let messageContent = content?.trim() || "";
    if (image) {
      const { filename } = saveUploadedImage(image);
      const imageMarkdown = `![photo](/api/images/${filename})`;
      messageContent = messageContent
        ? `${imageMarkdown}\n\n${messageContent}`
        : imageMarkdown;
    }

    // Persist the user message (authored by the sender) and fan it out live to
    // every other participant's socket.
    const stored = addMessage(convoId, "user", messageContent, { authorId: userId });
    autoTitle(convoId);
    publishToRoom(convoId, { type: "message", message: stored });
    // Notify the other participants (global socket → unread + system alert).
    const sender = getUser(userId)?.display_name ?? "Someone";
    const convo = getConversation(convoId, userId);
    notifyActivity(convoId, userId, { title: convo?.title ?? "", author: sender, preview: preview(messageContent) });
  }

  // Decide whether Maurice answers. A 1:1 chat (single participant) always
  // summons him; in a multi-human room he answers only when @-mentioned.
  // Regenerate is always a fresh-answer request.
  const isRoom = countParticipants(convoId) > 1;
  const summoned =
    regenerate ||
    (summonFlag !== undefined
      ? summonFlag
      : !isRoom || (typeof content === "string" && mentionsMaurice(content)));

  if (!summoned) {
    // Humans talking to each other — the authored message is stored + broadcast;
    // Maurice stays silent until summoned.
    return c.json({ ok: true, summoned: false });
  }
  publishToRoom(convoId, { type: "summoned", by: userId });

  // Get user profile for system prompt
  const user = getUser(userId);

  // Aborts when the client hangs up (the app's ⏹ Stop tears down the request) —
  // forwarded to the upstream model so generation actually halts.
  const signal = c.req.raw.signal;

  // Stream with throttled flushing — accumulate text and emit every ~30ms
  // so the client sees a smooth streaming effect even when Anthropic is fast
  return c.body(
    new ReadableStream({
      type: "direct",
      async pull(controller) {
        const encoder = new TextEncoder();
        let fullResponse = "";
        // Structured tool results collected from the stream, persisted with the
        // turn and rendered client-side beside the prose.
        const dataBlocks: { tool: string; data: unknown }[] = [];
        let pendingText = "";
        let lastFlush = Date.now();
        const FLUSH_INTERVAL = 30; // ms between flushes

        // Persist Maurice's reply (idempotent). Called on normal completion and
        // again if the client aborts mid-stream (⏹ Stop), so whatever streamed so
        // far is kept and fanned out over the room socket rather than lost.
        let persisted = false;
        const persistReply = () => {
          if (persisted || !fullResponse) return null;
          persisted = true;
          const msg = addMessage(convoId, "assistant", fullResponse, {
            mauriceId: summonedMaurice,
            data: dataBlocks.length ? dataBlocks : null,
          });
          // Refresh the semantic index (fire-and-forget) and fan the reply out to
          // the other participants' sockets + activity notifications.
          indexConversationInBackground(userId, convoId);
          publishToRoom(convoId, { type: "message", message: msg });
          const convo = getConversation(convoId, userId);
          notifyActivity(convoId, userId, { title: convo?.title ?? "", author: "Maurice", preview: preview(fullResponse) });
          return msg;
        };

        const flushPending = async () => {
          if (!pendingText) return;
          const text = pendingText;
          pendingText = "";
          controller.write(
            encoder.encode(JSON.stringify({ type: "text_delta", text }) + "\n")
          );
          await controller.flush();
          lastFlush = Date.now();
        };

        try {
          for await (const event of streamResponse(
            convoId,
            user?.display_name || "User",
            user?.profile_text,
            userId,
            signal
          )) {
            if (event.type === "text_delta" && event.text) {
              fullResponse += event.text;
              pendingText += event.text;

              // Flush if enough time has passed
              const elapsed = Date.now() - lastFlush;
              if (elapsed >= FLUSH_INTERVAL) {
                await flushPending();
              } else {
                // Wait for the remainder of the interval then flush
                await new Promise((r) =>
                  setTimeout(r, FLUSH_INTERVAL - elapsed)
                );
                await flushPending();
              }
              continue;
            }

            if (event.type === "done") continue;

            // Structured tool result: keep a copy to persist with the turn, then
            // fall through to forward it to the client for live rendering.
            if (event.type === "tool_data" && event.data != null) {
              dataBlocks.push({ tool: event.tool ?? "tool", data: event.data });
            }

            // Everything else (tool_call, tool_data, errors) — flush pending
            // text first so ordering stays correct, then forward the event.
            await flushPending();
            controller.write(
              encoder.encode(JSON.stringify(event) + "\n")
            );
            await controller.flush();
          }

          // Flush any remaining text
          await flushPending();

          // Check if Claude wants to generate an image
          const imageMatch = fullResponse.match(
            /^\s*\[IMAGE:\s*(.+?)\]\s*$/s
          );
          if (imageMatch) {
            const imagePrompt = imageMatch[1]!.trim();
            const config = getHouseholdConfig();
            if (config.falApiKey) {
              try {
                // Tell client we're generating an image
                controller.write(
                  encoder.encode(
                    JSON.stringify({
                      type: "image_loading",
                      text: imagePrompt,
                    }) + "\n"
                  )
                );
                await controller.flush();

                // Send keepalive events so the connection doesn't timeout
                const keepalive = setInterval(async () => {
                  try {
                    controller.write(
                      encoder.encode(
                        JSON.stringify({ type: "image_loading", text: imagePrompt }) + "\n"
                      )
                    );
                    await controller.flush();
                  } catch {}
                }, 15_000);

                let filename: string;
                try {
                  ({ filename } = await generateImage(
                    imagePrompt,
                    config.falApiKey
                  ));
                } finally {
                  clearInterval(keepalive);
                }
                const imageUrl = `/api/images/${filename}`;
                // Replace response with image markdown
                fullResponse = `![${imagePrompt}](${imageUrl})`;

                // Send the image event so client can render immediately
                controller.write(
                  encoder.encode(
                    JSON.stringify({
                      type: "image",
                      image_url: imageUrl,
                      text: imagePrompt,
                    }) + "\n"
                  )
                );
                await controller.flush();
              } catch (err: any) {
                // Image generation failed — keep the text response
                controller.write(
                  encoder.encode(
                    JSON.stringify({
                      type: "error",
                      message: `Image generation failed: ${err.message}`,
                    }) + "\n"
                  )
                );
                await controller.flush();
                fullResponse = `I tried to generate an image but it failed: ${err.message}`;
              }
            }
          }

          // Check if Claude wants to edit an uploaded image
          const editMatch = fullResponse.match(
            /^\s*\[EDIT_IMAGE:\s*(.+?)\]\s*$/s
          );
          if (editMatch) {
            const editPrompt = editMatch[1]!.trim();
            const config = getHouseholdConfig();
            if (config.falApiKey) {
              try {
                // Find the most recent user message with an uploaded photo
                const messages = getMessages(convoId);
                const imagePattern = /!\[.*?\]\(\/api\/images\/(.+?)\)/;
                let sourceFilename: string | null = null;
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i]!;
                  if (msg.role !== "user") continue;
                  const m = msg.content.match(imagePattern);
                  if (m) {
                    sourceFilename = m[1]!;
                    break;
                  }
                }

                if (!sourceFilename) {
                  fullResponse =
                    "I'd love to edit an image for you, but I couldn't find an uploaded photo in this conversation. Could you share one?";
                } else {
                  controller.write(
                    encoder.encode(
                      JSON.stringify({
                        type: "image_loading",
                        text: editPrompt,
                      }) + "\n"
                    )
                  );
                  await controller.flush();

                  // Send keepalive events so the connection doesn't timeout
                  const keepalive = setInterval(async () => {
                    try {
                      controller.write(
                        encoder.encode(
                          JSON.stringify({ type: "image_loading", text: editPrompt }) + "\n"
                        )
                      );
                      await controller.flush();
                    } catch {}
                  }, 15_000);

                  const dataUri = loadImageAsDataUri(sourceFilename);
                  let filename: string;
                  try {
                    ({ filename } = await editImage(
                      dataUri,
                      editPrompt,
                      config.falApiKey
                    ));
                  } finally {
                    clearInterval(keepalive);
                  }
                  const imageUrl = `/api/images/${filename}`;
                  fullResponse = `![${editPrompt}](${imageUrl})`;

                  controller.write(
                    encoder.encode(
                      JSON.stringify({
                        type: "image",
                        image_url: imageUrl,
                        text: editPrompt,
                      }) + "\n"
                    )
                  );
                  await controller.flush();
                }
              } catch (err: any) {
                controller.write(
                  encoder.encode(
                    JSON.stringify({
                      type: "error",
                      message: `Image edit failed: ${err.message}`,
                    }) + "\n"
                  )
                );
                await controller.flush();
                fullResponse = `I tried to edit the image but it failed: ${err.message}`;
              }
            }
          }

          const msg = persistReply();
          if (msg) {
            controller.write(
              encoder.encode(
                JSON.stringify({ type: "done", message_id: msg.id }) + "\n"
              )
            );
            await controller.flush();
          }
        } catch (err: any) {
          // Client hung up (⏹ Stop) or the stream broke — keep the partial reply,
          // and only bother reporting an error if anyone's still listening.
          persistReply();
          if (!signal.aborted) {
            try {
              controller.write(
                encoder.encode(
                  JSON.stringify({
                    type: "error",
                    message: err.message || "Stream failed",
                  }) + "\n"
                )
              );
            } catch {}
          }
        }

        try { controller.close(); } catch {}
      },
    }) as any,
    {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    }
  );
});

export default conversations;
