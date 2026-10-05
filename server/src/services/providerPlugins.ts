// Provider plugins — a seam for an inference provider that is not part of
// this repository.
//
// The server dispatches a turn on `models.provider` (services/claude.ts). The
// providers it knows are built in; this registry is how a household adds one
// of its own without the code living here: a module on the machine, named in
// MAURICE_PROVIDER_PLUGINS, registers itself at boot (see
// providerPluginLoader.ts). Nothing is registered unless that variable is set.
//
// This file is the registry alone and imports nothing, so pricing, budget and
// the model roster can consult it without an import cycle.

/** What a plugin is handed for one turn. Text only: no tools, no attachments. */
export interface ProviderTurn {
  conversationId: string;
  /** Whose turn it is. The server refuses a plugin turn without one. */
  memberId: string;
  /** The roster id of the model the turn resolved to. */
  model: string;
  system: string;
  /** The fitted history, oldest first, ending with this turn's user message. */
  messages: Array<{ role: string; content: string }>;
  /** The member's language, for any message the plugin words itself. */
  lang: string;
  signal?: AbortSignal;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  /** Reasoning in progress — an activity signal, never the reasoning itself. */
  | { type: "thinking" }
  | { type: "usage"; input: number; output: number; cache_read?: number; cache_write?: number }
  /** Ends the turn. The server shows the message; it never tries another provider. */
  | { type: "error"; message: string };

export interface ProviderPlugin {
  /** The value of `models.provider` this plugin answers for. */
  provider: string;
  /** Whether its models belong in the rosters right now. A turn on a model
   *  whose plugin says no still reaches `turn`, which answers with an error:
   *  a switched-off provider is said, not silently replaced. */
  configured(): boolean;
  /** False when nobody is billed per token (a flat subscription, a local
   *  runtime): the turn then costs nothing and no spending cap applies, exactly
   *  as for Ollama. Default true. */
  metered?: boolean;
  turn(t: ProviderTurn): AsyncGenerator<ProviderEvent>;
  /** An admin page of the plugin's own, served under /admin/x/<provider>/ behind
   *  the admin's loopback and session checks. `path` is what follows that prefix. */
  admin?(req: Request, path: string): Response | Promise<Response>;
}

const plugins = new Map<string, ProviderPlugin>();

export function registerProviderPlugin(p: ProviderPlugin): void {
  plugins.set(p.provider, p);
}

export function providerPlugin(provider: string): ProviderPlugin | null {
  return plugins.get(provider) ?? null;
}

/** Providers whose plugin is loaded and says it is usable. */
export function configuredPluginProviders(): string[] {
  return [...plugins.values()].filter((p) => p.configured()).map((p) => p.provider);
}

/** Nobody is billed per token for this provider: Ollama, or a plugin that says so. */
export function isUnmetered(provider: string | null | undefined): boolean {
  if (provider === "ollama") return true;
  return !!provider && plugins.get(provider)?.metered === false;
}

/** Test-only. */
export function _resetProviderPlugins(): void {
  plugins.clear();
}
