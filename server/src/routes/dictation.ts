// /api/dictation — a dictated clip, transcribed by the household's server.
// See services/dictation.ts for the engines and why the apps send clips here.
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  DictationError, MAX_BYTES, MAX_SECONDS, dictationEngine, transcribe,
} from "../services/dictation";

const dictation = new Hono();

dictation.use("/*", requireAuth);

// ── GET /api/dictation ──────────────────────────────────────────
// Whether a clip sent now would be transcribed, and by what. The apps ask once
// per session to decide between recording for the server and their own
// recogniser. `local` means the audio stays in the house.
dictation.get("/", (c) => {
  const engine = dictationEngine();
  return c.json({ available: engine != null, engine, max_seconds: MAX_SECONDS });
});

// ── POST /api/dictation?duration=12.4 ───────────────────────────
// The body is the clip itself (AAC in an .m4a from the apps; WAV, MP3, WebM
// and the rest are read too). Answers { text, engine, seconds }. Builds before
// 18 October 2026 also send `language`, their interface's; it is ignored, and
// Whisper hears the language for itself.
dictation.post("/", async (c) => {
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_BYTES) return c.json({ error: "too_long" }, 413);
  const audio = await readCapped(c.req.raw.body, MAX_BYTES);
  if (!audio) return c.json({ error: "too_long" }, 413);
  const duration = Number(c.req.query("duration"));
  try {
    const result = await transcribe({
      audio,
      mediaType: c.req.header("Content-Type") ?? "audio/mp4",
      clientSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      memberId: c.get("userId"),
    });
    return c.json({ text: result.text, engine: result.engine, seconds: result.seconds });
  } catch (e) {
    if (e instanceof DictationError) return c.json({ error: e.message }, e.status);
    console.error(`[dictation] ${(e as Error)?.stack ?? e}`);
    return c.json({ error: "Transcription failed." }, 500);
  }
});

/** The body, read until it passes `cap` — a chunked upload carries no length
 *  to refuse it by, and must not be held whole before it is measured. Null
 *  when it ran past. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export default dictation;
