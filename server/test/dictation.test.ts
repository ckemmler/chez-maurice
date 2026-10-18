/**
 * Dictation transcribed by the server: what reaches Whisper, what comes back
 * to the composer, what is metered — and a route that says plainly when the
 * household has no engine instead of pretending to listen.
 *
 * No clip is transcribed here: that needs whisper.cpp and a model, or a
 * Scaleway key, and the suite must pass without either.
 */
import { afterEach, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const db = (await import("../src/db")).default;
const route = (await import("../src/routes/dictation")).default;
const { createSession } = await import("../src/services/auth");
const {
  billedSeconds, cleanTranscript, dictationEngine, vocabularyPrompt,
} = await import("../src/services/dictation");

const auth = { Authorization: `Bearer ${createSession(MEMBER.id).token}` };

afterEach(() => {
  delete process.env.MAURICE_DICTATION_ENGINE;
});

test("silence that Whisper filled with subtitle credits reaches the composer as nothing", () => {
  expect(cleanTranscript(" Sous-titres réalisés par la communauté d'Amara.org\n")).toBe("");
  expect(cleanTranscript("Thanks for watching!")).toBe("");
  expect(cleanTranscript("[Musique]")).toBe("");
  expect(cleanTranscript("...")).toBe("");
  // A real sentence that merely opens like a credit is kept.
  expect(cleanTranscript("Merci, je regarde ça demain.")).toBe("Merci, je regarde ça demain.");
  expect(cleanTranscript("Thanks for watching the kids yesterday, see you Sunday.")).toBe(
    "Thanks for watching the kids yesterday, see you Sunday.",
  );
  expect(cleanTranscript("Sous-titres du film à corriger demain.")).toBe("Sous-titres du film à corriger demain.");
});

test("an upload is refused once it runs past the cap, length declared or not", async () => {
  const { readCapped } = await import("../src/routes/dictation");
  const stream = (n: number) => new Blob([new Uint8Array(n)]).stream();
  expect((await readCapped(stream(10), 16))?.byteLength).toBe(10);
  expect(await readCapped(stream(32), 16)).toBeNull();
  expect((await readCapped(null, 16))?.byteLength).toBe(0);
});

test("end credits Whisper tacked on after real speech are dropped, the member's own thanks kept", () => {
  // The 16 October 2026 dictation: 64 s of audio for 20 s of speech.
  expect(cleanTranscript("Tu peux ignorer ceci. C'était juste pour tester la dictée. Merci d'avoir regardé cette vidéo !")).toBe(
    "Tu peux ignorer ceci. C'était juste pour tester la dictée.",
  );
  expect(cleanTranscript("Déplacé à jeudi, 15h ? Merci. Sous-titrage Société Radio-Canada")).toBe(
    "Déplacé à jeudi, 15h ? Merci.",
  );
  expect(cleanTranscript("See you Sunday. Thanks for watching!")).toBe("See you Sunday.");
  // A closing thank-you is the member's.
  expect(cleanTranscript("Can you send it tomorrow? Thank you.")).toBe("Can you send it tomorrow? Thank you.");
  expect(cleanTranscript("Rappelle-moi demain. Merci de votre attention.")).toBe("Rappelle-moi demain. Merci de votre attention.");
  // A credit in the middle is not an ending, and is left alone.
  expect(cleanTranscript("Merci d'avoir regardé cette vidéo ! C'était la mienne.")).toBe(
    "Merci d'avoir regardé cette vidéo ! C'était la mienne.",
  );
});

test("the voice detector is found beside the models and never taken for one", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { vadModel, whisperModel } = await import("../src/services/dictation");
  const home = mkdtempSync(join(tmpdir(), "dict-home-"));
  const dir = join(home, ".maurice", "models", "whisper");
  (await import("node:fs")).mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ggml-silero-v5.1.2.bin"), "");
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(whisperModel()).toBeNull();
    expect(vadModel()).toBe(join(dir, "ggml-silero-v5.1.2.bin"));
    writeFileSync(join(dir, "ggml-large-v3-turbo.bin"), "");
    expect(whisperModel()).toBe(join(dir, "ggml-large-v3-turbo.bin"));
  } finally {
    process.env.HOME = previous;
  }
});

test("Whisper's lines and spacing come back as one clean paragraph", () => {
  expect(cleanTranscript(" Bonjour Maurice,\n  peux-tu rappeler à Aline\n\n le rendez-vous ? ")).toBe(
    "Bonjour Maurice, peux-tu rappeler à Aline le rendez-vous ?",
  );
});

test("the vocabulary carries the household's names", () => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('dict-aline', 'aline-dict', 'Aline', 'standard')`);
  const prompt = vocabularyPrompt();
  expect(prompt).toContain("Maurice");
  expect(prompt).toContain("Aline");
  expect(prompt.endsWith(".")).toBe(true);
  expect(prompt.length).toBeLessThanOrEqual(401);
});

test("a Scaleway clip is metered on what Scaleway bills, and never on nothing", () => {
  const audio = new Uint8Array(64_000);
  expect(billedSeconds({ usage: { type: "duration", seconds: 8 } }, { audio, clientSeconds: 7.6 })).toBe(8);
  expect(billedSeconds({ duration: 9.5 }, { audio, clientSeconds: 7.6 })).toBe(9.5);
  expect(billedSeconds({}, { audio, clientSeconds: 7.6 })).toBe(7.6);
  // Nothing reported, nothing measured: the size, at a bitrate that guesses high.
  expect(billedSeconds({}, { audio, clientSeconds: null })).toBe(32);
});

test("an engine forced off is no engine, and the route says so", async () => {
  process.env.MAURICE_DICTATION_ENGINE = "off";
  expect(dictationEngine()).toBeNull();

  const info = await route.request("/", { headers: auth });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ available: false, engine: null });

  const sent = await route.request("/?language=fr", {
    method: "POST", headers: { ...auth, "Content-Type": "audio/mp4" }, body: new Uint8Array([1, 2, 3]),
  });
  expect(sent.status).toBe(503);
});

test("an empty recording is refused before any engine is asked", async () => {
  const res = await route.request("/", {
    method: "POST", headers: { ...auth, "Content-Type": "audio/mp4" }, body: new Uint8Array(),
  });
  expect(res.status).toBe(400);
});

test("a clip the client says runs past ten minutes is refused", async () => {
  const res = await route.request("/?duration=900", {
    method: "POST", headers: { ...auth, "Content-Type": "audio/mp4" }, body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(413);
});

test("nobody signed in transcribes anything", async () => {
  expect((await route.request("/")).status).toBe(401);
  expect((await route.request("/", { method: "POST", body: new Uint8Array([1]) })).status).toBe(401);
});
