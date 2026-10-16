/**
 * Dictation transcribed by the household's server.
 *
 * The apps transcribe on the device where the device has a good model for it
 * (SpeechAnalyzer, iOS and macOS 26). Where it hasn't — an older system, a
 * language with no local model, or a member who asks for it — they record the
 * dictation and send the clip here, and Whisper hears it whole: one pass over
 * the full recording, with the sentence around every word, where the device's
 * streaming recogniser only ever had the last few syllables to go on.
 *
 * Two engines, chosen in this order:
 *
 *  - **local** — whisper.cpp on the machine the server runs on. The audio
 *    never leaves the house, and it costs nothing. Picked when `whisper-cli`,
 *    a model and `ffmpeg` are all found.
 *  - **scaleway** — `whisper-large-v3` through the household's Scaleway key,
 *    for a household whose server is a container with no model of its own.
 *    Metered like a chat turn, at €0.003 a minute of audio.
 *
 * `MAURICE_DICTATION_ENGINE` (`local`, `scaleway`, `off`) forces one;
 * `MAURICE_WHISPER_BIN` and `MAURICE_WHISPER_MODEL` point at a binary or a
 * model elsewhere than where Homebrew and ~/.maurice/models/whisper put them.
 *
 * Nothing heard is kept: the clip lives in a temporary directory for the
 * length of the request, and the log line records the engine and the
 * duration, never the words.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSpend, verdict } from "./budget";
import { getHouseholdConfig, openaiStyleBaseUrl } from "./claude";
import { listMaurices } from "./maurices";
import type { TurnUsage } from "./pricing";
import { householdName, listUsers } from "./users";

export type DictationEngine = "local" | "scaleway";

/** The longest clip accepted. A dictated message, not a meeting. */
export const MAX_SECONDS = 10 * 60;
/** OpenAI's limit for the transcription endpoint, which Scaleway mirrors; a
 *  ten-minute AAC clip at the apps' bitrate is a fraction of it. */
export const MAX_BYTES = 25 * 1024 * 1024;

/** Scaleway's list price — https://www.scaleway.com/en/pricing/model-as-a-service/,
 *  read 16 October 2026: €0.003 per minute of audio, nothing for the text. */
export const SCALEWAY_MODEL = "whisper-large-v3";
const SCALEWAY_EUR_PER_MINUTE = 0.003;

/** What a local transcription may take before it is abandoned. Turbo on an
 *  M-series Mac does a minute of speech in a couple of seconds; this is for a
 *  process that hung, not for a slow one. */
const LOCAL_TIMEOUT_MS = 120_000;

export class DictationError extends Error {
  constructor(message: string, readonly status: 400 | 402 | 413 | 502 | 503 = 502) {
    super(message);
  }
}

// ── Finding the engine ─────────────────────────────────────────────────────

/** The first of these that exists. Homebrew's prefix differs by architecture,
 *  and launchd hands the server a PATH that has neither. */
function firstExisting(paths: Array<string | undefined | null>): string | null {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

export function whisperBinary(): string | null {
  return firstExisting([
    process.env.MAURICE_WHISPER_BIN,
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    Bun.which("whisper-cli"),
  ]);
}

export function ffmpegBinary(): string | null {
  return firstExisting(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", Bun.which("ffmpeg")]);
}

/** The model to load: the one named, or the best ggml model found in
 *  ~/.maurice/models/whisper — large before medium before small, turbo
 *  preferred among the large ones for its speed. */
export function whisperModel(): string | null {
  const named = process.env.MAURICE_WHISPER_MODEL;
  if (named) return existsSync(named) ? named : null;
  const dir = join(process.env.HOME || "/tmp", ".maurice", "models", "whisper");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"));
  } catch {
    return null;
  }
  const rank = (f: string) =>
    (f.includes("large-v3-turbo") ? 0 : f.includes("large") ? 1 : f.includes("medium") ? 2 : f.includes("small") ? 3 : 4);
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return files[0] ? join(dir, files[0]) : null;
}

/** Which engine would transcribe a clip now, or null when none can. */
export function dictationEngine(): DictationEngine | null {
  const forced = process.env.MAURICE_DICTATION_ENGINE?.trim().toLowerCase();
  if (forced === "off") return null;
  const local = !!(whisperBinary() && whisperModel() && ffmpegBinary());
  const scaleway = !!getHouseholdConfig().scalewayApiKey;
  if (forced === "local") return local ? "local" : null;
  if (forced === "scaleway") return scaleway ? "scaleway" : null;
  if (local) return "local";
  if (scaleway) return "scaleway";
  return null;
}

// ── What Whisper should expect to hear ──────────────────────────────────────

/**
 * The names this household says aloud, as Whisper's initial prompt.
 *
 * Whisper takes the prompt as text that came before the clip, and spells what
 * it hears the way that text did: "Aline" rather than "Alain", "Maurice" with
 * its capital. Members, the household's own name and its Maurices — the words
 * a general model has the least chance of getting right on its own. Bounded:
 * the prompt has room for 224 tokens, and the clip's own words matter more.
 */
export function vocabularyPrompt(): string {
  const names = new Set<string>(["Maurice", "Carnet"]);
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t && t.length <= 40) names.add(t);
  };
  add(householdName());
  for (const u of listUsers()) add(u.display_name);
  for (const m of listMaurices()) add(m.name);
  let out = "";
  for (const n of names) {
    const next = out ? `${out}, ${n}` : n;
    if (next.length > 400) break;
    out = next;
  }
  return out ? `${out}.` : "";
}

/** A two-letter language code, or null when the client sent none usable — in
 *  which case Whisper detects the language itself. */
export function normaliseLanguage(raw: string | null | undefined): string | null {
  const code = raw?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

/**
 * What Whisper writes when there was nothing to write.
 *
 * Trained on subtitled video, it fills silence with the credits it saw most:
 * "Sous-titres réalisés par la communauté d'Amara.org", "Thanks for watching".
 * A clip that transcribes to nothing but one of these was silence, and the
 * composer should receive nothing rather than a line of somebody's subtitles.
 *
 * Whole-text matches only, once case and punctuation are set aside: a member
 * who says "thanks for watching the kids" said it, and keeps it.
 */
const SILENCE_HALLUCINATIONS_RAW = [
  "sous-titres réalisés par la communauté d'amara.org",
  "sous-titres réalisés para la communauté d'amara.org",
  "sous-titrage st' 501",
  "sous-titrage société radio-canada",
  "merci d'avoir regardé",
  "merci d'avoir regardé cette vidéo",
  "merci de votre attention",
  "thanks for watching",
  "thank you for watching",
  "thank you",
  "subtitles by the amara.org community",
  "musique",
  "music",
  "silence",
  "applaudissements",
  "applause",
  "rires",
  "laughter",
  "",
];

function silenceKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[\[\]()*♪.!?…,:;"«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compared the way a transcript is: through silenceKey. */
const SILENCE_HALLUCINATIONS = new Set(SILENCE_HALLUCINATIONS_RAW.map(silenceKey));

export function cleanTranscript(raw: string): string {
  const text = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (SILENCE_HALLUCINATIONS.has(silenceKey(text))) return "";
  return text;
}

// ── Transcribing ────────────────────────────────────────────────────────────

export interface TranscribeInput {
  audio: Uint8Array;
  /** As sent: `audio/mp4`, `audio/m4a`, `audio/wav`… Used for the file name
   *  the engines see, which is how ffmpeg and Scaleway tell formats apart. */
  mediaType: string;
  language: string | null;
  /** The client's own measure of the clip, in seconds. Used to meter a
   *  Scaleway transcription when the provider reports no duration. */
  clientSeconds: number | null;
  memberId: string;
}

export interface TranscribeResult {
  text: string;
  engine: DictationEngine;
  seconds: number | null;
  /** Euros, or 0 for the local engine. */
  cost: number;
}

function extensionFor(mediaType: string): string {
  const t = mediaType.toLowerCase();
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("flac")) return "flac";
  return "m4a";
}

export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  if (input.audio.byteLength === 0) throw new DictationError("The recording is empty.", 400);
  if (input.audio.byteLength > MAX_BYTES) throw new DictationError("The recording is too long.", 413);
  if (input.clientSeconds != null && input.clientSeconds > MAX_SECONDS + 5) {
    throw new DictationError("The recording is too long.", 413);
  }
  const engine = dictationEngine();
  if (!engine) throw new DictationError("This household has no transcription engine.", 503);
  const started = Date.now();
  const result = engine === "local" ? await transcribeLocally(input) : await transcribeWithScaleway(input);
  console.log(
    `[dictation] engine=${engine} member=${input.memberId} seconds=${result.seconds?.toFixed(1) ?? "?"} ` +
      `ms=${Date.now() - started} chars=${result.text.length}`,
  );
  return result;
}

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeLocally(input: TranscribeInput): Promise<TranscribeResult> {
  const whisper = whisperBinary();
  const model = whisperModel();
  const ffmpeg = ffmpegBinary();
  if (!whisper || !model || !ffmpeg) throw new DictationError("Local transcription is not installed.", 503);

  const dir = mkdtempSync(join(tmpdir(), "maurice-dictation-"));
  try {
    const source = join(dir, `clip.${extensionFor(input.mediaType)}`);
    const wav = join(dir, "clip.wav");
    await Bun.write(source, input.audio);

    // whisper.cpp reads 16 kHz mono PCM and nothing else.
    const convert = await run(
      [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", source,
       "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav],
      30_000,
    );
    if (convert.code !== 0) {
      console.error(`[dictation] ffmpeg failed: ${convert.stderr.trim().slice(0, 300)}`);
      throw new DictationError("The recording could not be read.", 400);
    }
    // 16-bit mono at 16 kHz after a 44-byte header: the duration, exactly.
    const seconds = Math.max(0, (Bun.file(wav).size - 44) / 32_000);
    if (seconds > MAX_SECONDS + 5) throw new DictationError("The recording is too long.", 413);

    const args = [whisper, "-m", model, "-f", wav, "-nt", "-np", "-sns",
                  "-l", input.language ?? "auto"];
    const prompt = vocabularyPrompt();
    if (prompt) args.push("--prompt", prompt);
    const out = await run(args, LOCAL_TIMEOUT_MS);
    if (out.code !== 0) {
      console.error(`[dictation] whisper-cli failed (${out.code}): ${out.stderr.trim().slice(-300)}`);
      throw new DictationError("Transcription failed.", 502);
    }
    return { text: cleanTranscript(out.stdout), engine: "local", seconds, cost: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribeWithScaleway(input: TranscribeInput): Promise<TranscribeResult> {
  const config = getHouseholdConfig();
  const key = config.scalewayApiKey;
  if (!key) throw new DictationError("This household has no transcription engine.", 503);

  // Weighed before, on what the client says it recorded: the member's caps
  // decide whether the clip is sent at all, as they decide a chat turn.
  const estimate = ((input.clientSeconds ?? 60) / 60) * SCALEWAY_EUR_PER_MINUTE;
  const v = verdict("scaleway", null, estimate, input.memberId);
  if (!v.ok) throw new DictationError(v.reason ?? "Spending limit reached.", 402);

  const form = new FormData();
  form.append("file", new Blob([input.audio], { type: input.mediaType || "audio/mp4" }),
              `clip.${extensionFor(input.mediaType)}`);
  form.append("model", SCALEWAY_MODEL);
  form.append("response_format", "verbose_json");
  if (input.language) form.append("language", input.language);
  const prompt = vocabularyPrompt();
  if (prompt) form.append("prompt", prompt);

  let res: Response;
  try {
    res = await fetch(`${openaiStyleBaseUrl("scaleway", config)}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
  } catch (e: any) {
    console.error(`[dictation] scaleway unreachable: ${e?.message ?? e}`);
    throw new DictationError("The transcription service could not be reached.", 502);
  }
  if (!res.ok) {
    console.error(`[dictation] scaleway ${res.status}: ${(await res.text()).slice(0, 300)}`);
    throw new DictationError("Transcription failed.", 502);
  }
  const body = (await res.json().catch(() => ({}))) as {
    text?: string;
    duration?: number;
    usage?: { type?: string; seconds?: number };
  };
  const seconds = billedSeconds(body, input);
  const cost = (seconds / 60) * SCALEWAY_EUR_PER_MINUTE;
  const usage: TurnUsage = {
    provider: "scaleway", model: SCALEWAY_MODEL, rounds: 1,
    input: 0, output: 0, cache_read: 0, cache_write: 0,
    cost, cost_uncached: cost,
  };
  recordSpend(usage, input.memberId);
  return { text: cleanTranscript(body.text ?? ""), engine: "scaleway", seconds, cost };
}

/**
 * The seconds a Scaleway transcription is metered on.
 *
 * Scaleway reports what it bills in `usage.seconds` (16 October 2026) and,
 * unlike OpenAI's verbose_json, no `duration`. Read the bill first, then the
 * clip's own duration, then what the client measured. With none of them the
 * size decides, at 16 kbit/s — half the apps' bitrate, so the guess runs high:
 * a meter that reads low is the one wrong answer.
 */
export function billedSeconds(
  body: { duration?: number; usage?: { type?: string; seconds?: number } },
  input: Pick<TranscribeInput, "clientSeconds" | "audio">,
): number {
  const billed = body.usage?.seconds;
  if (typeof billed === "number" && billed > 0) return billed;
  if (typeof body.duration === "number" && body.duration > 0) return body.duration;
  if (input.clientSeconds != null && input.clientSeconds > 0) return input.clientSeconds;
  return input.audio.byteLength / 2000;
}
