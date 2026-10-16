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
  billedSeconds, cleanTranscript, dictationEngine, normaliseLanguage, vocabularyPrompt,
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

test("Whisper's lines and spacing come back as one clean paragraph", () => {
  expect(cleanTranscript(" Bonjour Maurice,\n  peux-tu rappeler à Aline\n\n le rendez-vous ? ")).toBe(
    "Bonjour Maurice, peux-tu rappeler à Aline le rendez-vous ?",
  );
});

test("the language is the bare code Whisper takes, or nothing", () => {
  expect(normaliseLanguage("fr")).toBe("fr");
  expect(normaliseLanguage("fr-BE")).toBe("fr");
  expect(normaliseLanguage("en_GB")).toBe("en");
  expect(normaliseLanguage("")).toBeNull();
  expect(normaliseLanguage("français")).toBeNull();
  expect(normaliseLanguage(undefined)).toBeNull();
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
