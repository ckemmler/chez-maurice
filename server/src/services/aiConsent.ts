/**
 * Consent to send a member's data to AI providers (App Review 5.1.2(i)).
 *
 * The apps ask once, after sign-in and before anything is sent: here are the
 * providers this household uses, here is what goes to them, yes or no. The
 * answer is stored per member with the list of providers it covered, so a
 * provider that appears later (a new key, a persona on another model) is not
 * covered until the member says yes again.
 *
 * The server holds the rule, not only the app: a member who said no gets no
 * chat turn, no background work (summaries, domains, mail reading, life
 * facts) and no server dictation on a provider outside the house. A local
 * model needs no consent — nothing leaves the machine.
 *
 * A member with no answer on file is let through: the apps that do not ask
 * yet (Android, the web) must keep working, and the iOS and macOS apps never
 * send before they have asked.
 */
import db from "../db";

export type ConsentStatus = "accepted" | "declined";

export interface ConsentRecord {
  status: ConsentStatus;
  providers: string[];
  decided_at: string;
}

export interface ProviderInfo {
  id: string;
  /** The service the data goes to, as its maker names it. */
  name: string;
  /** Where it is processed: ISO region code, and a city when it is known. */
  region: string | null;
  city: string | null;
}

/** Providers that run on the household's own machine. */
const LOCAL_PROVIDERS = new Set(["ollama"]);

const KNOWN: Record<string, Omit<ProviderInfo, "id">> = {
  scaleway: { name: "Scaleway Generative APIs", region: "FR", city: "Paris" },
  mistral: { name: "Mistral AI", region: "FR", city: "Paris" },
  anthropic: { name: "Anthropic", region: "US", city: null },
  openai: { name: "OpenAI", region: "US", city: null },
  gemini: { name: "Google Gemini", region: "US", city: null },
  zai: { name: "Z.ai (Zhipu AI)", region: "CN", city: null },
  "claude-code": { name: "Anthropic (Claude Code)", region: "US", city: null },
  fal: { name: "fal.ai (image generation)", region: "US", city: null },
  tavily: { name: "Tavily (web search)", region: "US", city: null },
};

export function isLocalProvider(provider: string | null | undefined): boolean {
  return !provider || LOCAL_PROVIDERS.has(provider);
}

export function providerInfo(id: string): ProviderInfo {
  return { id, ...(KNOWN[id] ?? { name: id, region: null, city: null }) };
}

/** The provider the corpus embeds with, read from the container's settings.
 *  Null at home, where embeddings run on the machine (Ollama). */
export function embeddingProvider(): string | null {
  const url = process.env.CORPUS_EMBEDDING_BASE_URL?.trim();
  if (!url) return null;
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return null;
  if (host.endsWith("scaleway.ai") || host.endsWith("scaleway.com") || host.endsWith("scw.cloud")) return "scaleway";
  if (host.endsWith("openai.com")) return "openai";
  if (host.endsWith("mistral.ai")) return "mistral";
  return host;
}

export function getConsent(userId: string): ConsentRecord | null {
  const row = db
    .query(`SELECT status, providers, decided_at FROM ai_consent WHERE user_id = ?`)
    .get(userId) as { status: ConsentStatus; providers: string; decided_at: string } | null;
  if (!row) return null;
  let providers: string[] = [];
  try {
    const parsed = JSON.parse(row.providers);
    if (Array.isArray(parsed)) providers = parsed.filter((p) => typeof p === "string");
  } catch {}
  return { status: row.status, providers, decided_at: row.decided_at };
}

export function setConsent(userId: string, status: ConsentStatus, providers: string[]): ConsentRecord {
  const list = [...new Set(providers.filter((p) => typeof p === "string" && p && !isLocalProvider(p)))].sort();
  db.run(
    `INSERT INTO ai_consent (user_id, status, providers, decided_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, providers = excluded.providers, decided_at = excluded.decided_at`,
    [userId, status, JSON.stringify(status === "accepted" ? list : [])],
  );
  return getConsent(userId)!;
}

/** May this member's data go to this provider? Work not done for a member
 *  (no id) is the household's own and is not asked about here. */
export function aiAllowed(userId: string | null | undefined, provider: string | null | undefined): boolean {
  if (!userId || isLocalProvider(provider)) return true;
  const rec = getConsent(userId);
  if (!rec) return true;
  if (rec.status === "declined") return false;
  return rec.providers.includes(provider!);
}

/** The providers among `inUse` the member has not accepted yet (none when
 *  they have no answer on file and nothing is asked of them). */
export function uncovered(userId: string, inUse: string[]): string[] {
  const rec = getConsent(userId);
  const remote = inUse.filter((p) => !isLocalProvider(p));
  if (!rec || rec.status === "declined") return remote;
  return remote.filter((p) => !rec.providers.includes(p));
}

export class AiConsentError extends Error {
  constructor(public readonly provider: string) {
    super(`ai_consent_required:${provider}`);
  }
}
