/**
 * Where the corpus stops answering — the bench behind SCORE_FLOOR.
 *
 * A semantic index has no notion of "I don't know": asked something it holds
 * nothing about, it still returns its ten least-distant chunks. The only thing
 * that separates an answer from the least-bad chunk is the score, and the only
 * honest way to set that threshold is to measure both families on a real
 * index. This replays sixteen questions — eight the corpus can answer, eight
 * it cannot — against each of the two layers the model actually asks for, and
 * prints the best three titles with their scores.
 *
 * Read the output by hand: a pair is a real answer when the best title is
 * about the question, noise when it is not. The question is not the label —
 * the garden holds nothing on the Galápagos while the conversations do, so the
 * same question is a real hit on one layer and noise on the other.
 *
 * Re-run it after an embedding-model change (the scale moves with the model),
 * or when the index has grown enough to be a different thing.
 *
 *   MAURICE_MCP_TOKEN=… bun run server/scripts/corpus-floor.ts <member-id>
 *
 * The gateway must be up; the member id defaults to the household's admin.
 */
import { corpusCall } from "../src/services/mcpClient";
import db from "../src/db";

const GARDEN = { source_type: ["note", "fiche", "card", "fragment"] };
const CONVOS = { source_type: "conversation" };

/** Questions whose answer is somewhere in the member's own corpus. Replace
 *  them wholesale for another member — they are Candide's life, not a fixture. */
const ANSWERED = [
  "Qu'est-ce que Maurice, le système que je construis ?",
  "Qu'est-ce qu'on s'est dit sur le voyage aux Galápagos en famille ?",
  "Pourquoi suis-je végétarien et quels arguments on m'oppose ?",
  "Quel âge ont Emilio et Adriano ?",
  "Où en est la distribution TestFlight de l'app ?",
  "Qu'est-ce que je joue au violon en ce moment ?",
  "Quels livres sur la démocratie américaine ai-je lus ?",
  "Comment marche la sauvegarde de la flotte Maurice ?",
  // Written down as an outside fact on the first run, and it is not one: the
  // garden has a "Trains" note and the conversations hold the SNCB and STIB
  // ones. A bench is only worth its labels — check them against the titles
  // that come back, not against what the question sounds like.
  "Combien coûte un abonnement de train en Belgique en 2026 ?",
];

/** Outside facts, the kind a web search answers and a life does not. Keep them
 *  plausible-but-absent: a question about nothing at all is too easy a test. */
const UNANSWERED = [
  "Que veut dire le code d'erreur 0020 au marketplace ?",
  "Quelle est la capitale du Kazakhstan ?",
  "Quelles sont les règles du cricket ?",
  "Qui a gagné le Tour de France cette année ?",
  "Comment change-t-on une courroie de distribution ?",
  "Quel temps fera-t-il à Lisbonne la semaine prochaine ?",
  // The turn this floor was raised for. Its conversation layer now answers
  // with the failed turn itself, indexed since — the bench has no conversation
  // of its own to drop, where a live search drops the one it is taking place
  // in. Read that row as the garden row beside it.
  "Scoodle Plantyn Capture école app téléphone fils",
];

function defaultMember(): string {
  const row = db
    .query(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)
    .get() as { id?: string } | null;
  if (!row?.id) throw new Error("No admin member to search as — pass a member id.");
  return row.id;
}

const member = process.argv[2] || defaultMember();

async function probe(label: string, queries: string[]): Promise<void> {
  console.log(`\n## ${label}\n`);
  for (const query of queries) {
    for (const [layer, filters] of [["garden", GARDEN], ["convo", CONVOS]] as const) {
      const r = await corpusCall(member, "search", { query, filters, limit: 10 });
      const rows: any[] = r?.results ?? [];
      const top = rows.slice(0, 3).map((x) => {
        const name = x?.conversation_title || x?.title || x?.book_title || "(sans titre)";
        return `${Number(x?.score ?? 0).toFixed(3)} ${String(name).slice(0, 46)}`;
      });
      console.log(`${layer}\t${query.slice(0, 48).padEnd(48)}\t| ${top.join(" | ") || "(rien)"}`);
    }
  }
}

await probe("Le corpus tient la réponse", ANSWERED);
await probe("Le corpus ne sait rien", UNANSWERED);
