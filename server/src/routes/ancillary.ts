/**
 * One ancillary turn, for the tools that live beside this server.
 *
 * Every Python tool used to build its own `anthropic.Anthropic` client around
 * the model id the admin had chosen — so the choice was honoured in name only:
 * pick a Scaleway model for a dossier title and the id went to
 * api.anthropic.com and failed there. A household without an Anthropic key
 * could not run those functions at all, whatever it had chosen, and a project
 * that means to run on European infrastructure was quietly pinned to one
 * American vendor by its own tooling.
 *
 * This route is the way out: the tool says which invocation it is and what it
 * wants written, and the server resolves the model and dispatches it through
 * the same backends the chat uses. The tools keep no key and no SDK.
 *
 * Access: loopback only, the same test the admin dashboard uses
 * (middleware/loopback.ts). A tool runs in this container, or on this Mac,
 * next to the database it already reads directly; a request that arrived
 * through the tunnel is refused whatever Host it claims. No token to mint, to
 * store in a second place, or to leak — the boundary is the machine.
 */
import { Hono } from "hono";
import { isLoopbackRequest } from "../middleware/loopback";
import {
  AncillaryError, ancillaryComplete, ancillaryModel, isAncillaryInvocation,
} from "../services/ancillary";
import { recordSpend, verdict } from "../services/budget";
import { getModel } from "../services/models";
import { getUser } from "../services/users";

/** What one request may carry in pictures: a handful of pages, each a few
 *  hundred kilobytes once scaled by the tool that sends them. */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 6_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const ancillary = new Hono();

ancillary.use("/*", async (c, next) => {
  if (!isLoopbackRequest(c)) {
    return c.json({ error: "Ancillary turns are local-only" }, 403);
  }
  await next();
});

/** What a given invocation would run on. Lets a tool log it, or check itself. */
ancillary.get("/:invocation", (c) => {
  const invocation = c.req.param("invocation");
  if (!isAncillaryInvocation(invocation)) return c.json({ error: "Unknown invocation" }, 404);
  return c.json({ invocation, model: ancillaryModel(invocation) });
});

/**
 * Run one turn. `prompt` in, `text` out, with the model and provider that
 * served it so a caller can log what it actually got.
 */
ancillary.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    invocation?: string;
    prompt?: string;
    system?: string;
    max_tokens?: number;
    temperature?: number;
    effort?: "low" | "medium" | "high";
    /** An explicit model, for an experiment that compares them; see
     *  AncillaryRequest.model. Checked like a pin: roster and key. */
    model?: string;
    /** Pictures the prompt is about: `{ media_type, data }`, base64. */
    images?: Array<{ media_type?: string; data?: string }>;
    /** The member this turn is made for. Their caps are weighed before it
     *  and its cost is written to the ledger under their name. Without it
     *  the turn is the household's, as every tool's was. */
    member_id?: string;
  } | null;

  const invocation = body?.invocation ?? "";
  const prompt = body?.prompt ?? "";
  if (!isAncillaryInvocation(invocation)) return c.json({ error: "Unknown invocation" }, 400);
  if (!prompt.trim()) return c.json({ error: "prompt is required" }, 400);

  // A tool asking for a million tokens is a bug in the tool, not a budget the
  // household agreed to; the ceiling is generous and the floor is honest.
  const maxTokens = Math.min(Math.max(Number(body?.max_tokens) || 1024, 16), 32_000);

  const images: Array<{ mediaType: string; data: string }> = [];
  for (const image of Array.isArray(body?.images) ? body!.images! : []) {
    const mediaType = String(image?.media_type ?? "");
    const data = String(image?.data ?? "");
    if (!IMAGE_TYPES.has(mediaType) || !data) return c.json({ error: "an image needs a media_type (jpeg, png, webp, gif) and base64 data" }, 400);
    if (data.length > MAX_IMAGE_CHARS) return c.json({ error: "an image is too large" }, 413);
    images.push({ mediaType, data });
  }
  if (images.length > MAX_IMAGES) return c.json({ error: `at most ${MAX_IMAGES} images a turn` }, 400);

  // Whose turn: a tool that works for a member says so, and that member's
  // caps decide before anything is spent — the same fuse as their chat.
  const memberId = typeof body?.member_id === "string" && body.member_id.trim() ? body.member_id.trim() : null;
  if (memberId) {
    if (!getUser(memberId)) return c.json({ error: "Unknown member" }, 400);
    const modelId = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : ancillaryModel(invocation);
    const v = verdict(getModel(modelId)?.provider ?? null, modelId, 0, memberId);
    if (!v.ok) return c.json({ error: v.reason }, 402);
  }

  try {
    const result = await ancillaryComplete({
      invocation,
      prompt,
      system: body?.system,
      maxTokens,
      temperature: body?.temperature,
      effort: body?.effort,
      model: typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined,
      images: images.length ? images : undefined,
    });
    if (memberId) recordSpend(result.usage, memberId);
    return c.json(result);
  } catch (err) {
    if (err instanceof AncillaryError) {
      return c.json({ error: err.message }, err.status as 400 | 422 | 502);
    }
    console.error("[ancillary] turn failed:", (err as Error).message);
    return c.json({ error: "Ancillary turn failed" }, 502);
  }
});

export default ancillary;
