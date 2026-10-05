// Loads the provider plugins named in MAURICE_PROVIDER_PLUGINS (see
// providerPlugins.ts): absolute paths to modules, separated by `:`. Each
// module's default export is a function that takes the host below and returns
// a ProviderPlugin. Unset — the default — nothing is loaded.

import { getDataDir } from "../../data-api/lib/config";
import { addModel, type ModelInput } from "./models";
import { canUse } from "./modelAccess";
import { registerProviderPlugin, type ProviderPlugin } from "./providerPlugins";

/** What the server lends a plugin, so the plugin imports nothing from it and
 *  can live anywhere on the machine. */
export interface ProviderPluginHost {
  /** The household's data directory, for the plugin's own state. */
  dataDir: string;
  /** Put a model on the roster (idempotent). Admins may use it at once;
   *  standard members only once the access grid grants it. */
  addModel(input: ModelInput): void;
  /** The server's own access check, for a plugin that wants to ask again. */
  canUse(memberId: string, modelId: string): boolean;
}

export type ProviderPluginFactory = (host: ProviderPluginHost) => ProviderPlugin | Promise<ProviderPlugin>;

export async function loadProviderPlugins(spec = process.env.MAURICE_PROVIDER_PLUGINS): Promise<string[]> {
  const loaded: string[] = [];
  const host: ProviderPluginHost = {
    dataDir: getDataDir(),
    addModel: (input) => void addModel(input),
    canUse,
  };
  for (const path of (spec ?? "").split(":").map((s) => s.trim()).filter(Boolean)) {
    try {
      const mod = await import(path);
      const plugin = await (mod.default as ProviderPluginFactory)(host);
      registerProviderPlugin(plugin);
      loaded.push(plugin.provider);
      console.log(`[provider-plugin] loaded "${plugin.provider}" from ${path}`);
    } catch (err: any) {
      // A plugin that fails to load must not take the server down with it.
      console.error(`[provider-plugin] failed to load ${path}:`, err?.message ?? err);
    }
  }
  return loaded;
}
