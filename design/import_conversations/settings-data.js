// settings-data.js — Chez Maurice household admin (web).
// Self-contained: members, the model roster (Anthropic cloud + Ollama on-device),
// and the per-member access matrix. No dependency on the prototype's internals.

(function () {
  'use strict';

  // ── household members ─────────────────────────────────────────────────────
  // role: 'admin' can manage settings & access; 'standard' cannot.
  const MEMBERS = [
    { id: 'candide', name: 'Candide', handle: 'candide', role: 'admin',    pin: true, color: '#2a2622', avatar: 'avatars/candide-sq.png' },
    { id: 'paola',   name: 'Paola',   handle: 'paola',   role: 'standard', pin: true, color: '#7a4f6e', avatar: 'avatars/paola-sq.png' },
    { id: 'adriano', name: 'Adriano', handle: 'adriano', role: 'standard', pin: true, color: '#2c5aa0', avatar: 'avatars/adriano-sq.png' },
    { id: 'emilio',  name: 'Emilio',  handle: 'emilio',  role: 'standard', pin: true, color: '#b97a1e', avatar: 'avatars/emilio-sq.png' },
  ];

  // ── model roster ──────────────────────────────────────────────────────────
  // tier 'cloud' = Anthropic (metered). tier 'local' = Ollama on the house Mac
  // mini (private). `ram` GB is the resident size; `installed`/`discovered` flag
  // whether it came back from Ollama's GET /api/tags. `ctx` = context window k.
  const MODELS = [
    // cloud — Anthropic
    { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   tier: 'cloud', vendor: 'Anthropic', ctx: 200, desc: 'Deepest reasoning. Hard, multi-step problems.' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'cloud', vendor: 'Anthropic', ctx: 200, desc: 'Balanced and fast — the everyday default.' },
    { id: 'claude-haiku-4-6',  name: 'Claude Haiku 4.6',  tier: 'cloud', vendor: 'Anthropic', ctx: 200, desc: 'Quick and economical. Good for kids.' },
    // local — Ollama (discovered via /api/tags)
    { id: 'llama3.3:70b',       name: 'Llama 3.3 70B',      tier: 'local', vendor: 'Ollama', ram: 42, ctx: 128, discovered: true, desc: "Meta's flagship, fully on-device." },
    { id: 'qwen2.5:32b',        name: 'Qwen2.5 32B',        tier: 'local', vendor: 'Ollama', ram: 20, ctx: 128, discovered: true, desc: 'Strong all-rounder, comfortable headroom.' },
    { id: 'gemma2:27b',         name: 'Gemma 2 27B',        tier: 'local', vendor: 'Ollama', ram: 17, ctx: 8,   discovered: true, desc: "Google's efficient local model." },
    { id: 'deepseek-r1:32b',    name: 'DeepSeek-R1 32B',    tier: 'local', vendor: 'Ollama', ram: 20, ctx: 128, discovered: true, desc: 'Local chain-of-thought reasoning.' },
    { id: 'mistral-small:24b',  name: 'Mistral Small 24B',  tier: 'local', vendor: 'Ollama', ram: 15, ctx: 32,  discovered: true, desc: 'Snappy, low-memory everyday chat.' },
  ];

  // ── Ollama connection (what the discovery card reflects) ──────────────────
  const OLLAMA = {
    connected: true,
    host: 'http://studio.local:11434',
    version: '0.5.4',
    totalRamGB: 48,            // the Mac mini
    lastScan: 'just now',
  };

  // household-wide default model (must be allowed for a member, else they fall
  // back to their best available).
  const HOUSEHOLD = {
    name: 'Maison Maurice',
    anthropicKeySet: true,
    falKeySet: true,
    defaultModel: 'claude-sonnet-4-6',
    maxTokens: 32000,
  };

  // ── access matrix ─────────────────────────────────────────────────────────
  // access[memberId] = Set-like array of model ids the member may use.
  // Seeded: admins & adults get everything; kids get Haiku + all on-device
  // (no metered frontier models) — the kind of guardrail a parent wants.
  const ACCESS = {
    candide: MODELS.map((m) => m.id),
    paola:   MODELS.map((m) => m.id),
    adriano: ['claude-haiku-4-6', 'llama3.3:70b', 'qwen2.5:32b', 'gemma2:27b', 'deepseek-r1:32b', 'mistral-small:24b'],
    emilio:  ['claude-haiku-4-6', 'gemma2:27b', 'mistral-small:24b'],
  };

  Object.assign(window, { MEMBERS, MODELS, OLLAMA, HOUSEHOLD, ACCESS });
})();
