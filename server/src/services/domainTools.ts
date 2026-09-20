import type { McpTool } from "./mcpClient";
import { domainNames, findBriefByName, MEMBER_AUTHOR } from "./domainBriefs";

// ── domain_brief: the second storey ──────────────────────────────────────────
//
// The everyday prompt carries an *index* of the member's domains, one line
// each (services/domainBriefs.ts). This is how the brief behind a line is
// read, and it exists because the alternative was carrying all of them all the
// time: eleven briefs weigh about 4 900 tokens and they rode into a
// conversation about a holiday in the Galápagos, where not one applied.
//
// Native rather than MCP, like the domain proposal tools: briefs live in the
// server's own database, and the gateway has no business holding a member's
// working memory. Two consequences worth stating. It is scoped to the member
// taking the turn, so a name belonging to someone else's domain does not
// resolve — it does not exist as far as this tool is concerned. And it is
// offered only where the index is, which is to say never in a room.

export const DOMAIN_BRIEF_TOOL = "domain_brief";

export function isDomainBriefTool(name: string): boolean {
  return name === DOMAIN_BRIEF_TOOL;
}

/** The tool, when this turn is one that carries the index. */
export function domainBriefTool(): McpTool {
  return {
    name: DOMAIN_BRIEF_TOOL,
    description:
      "Read in full the brief you keep on one of the member's domains — your working memory on that part of their life. " +
      "The domains are listed by name in your system prompt, one line each; this returns the whole brief behind one of those lines. " +
      "Call it whenever a question falls into a domain and the one-line entry is not enough to answer well, before answering rather than after. " +
      "Asking for two domains in the same round is normal when a question sits between them.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The domain's name, as it appears in the list in your system prompt.",
        },
      },
      required: ["name"],
    },
  };
}

export interface BriefToolOutcome {
  text: string;
  isError: boolean;
  data?: unknown;
}

/**
 * Run it. A name that matches nothing is not an error the model should have to
 * guess at: the answer names the domains that do exist, so the next round can
 * be right.
 */
export function runDomainBriefTool(input: any, memberId: string | undefined): BriefToolOutcome {
  if (!memberId) return { text: "Tool error: no member on this turn", isError: true };
  const wanted = typeof input?.name === "string" ? input.name : "";
  const found = findBriefByName(memberId, wanted);
  if (!found) {
    const names = domainNames(memberId);
    return {
      text: names.length
        ? `No domain of theirs is called "${wanted}". Theirs are: ${names.join(", ")}.`
        : `They have no domains yet.`,
      isError: true,
    };
  }
  const { name, brief } = found;
  if (!brief || !brief.text.trim()) {
    return { text: `The brief on "${name}" is empty — nothing has been written into it yet.`, isError: false };
  }
  const payload = {
    domain: name,
    // A brief the member rewrote themselves outranks anything Maurice
    // remembers otherwise, and the model is told so rather than left to infer
    // it from an author field it has never seen.
    in_their_own_words: brief.model === MEMBER_AUTHOR,
    written: brief.updated_at.slice(0, 10),
    brief: brief.text.trim(),
  };
  const words = payload.in_their_own_words
    ? `The brief on "${name}", written ${payload.written} by the member themselves — it is theirs and prevails over anything you remember otherwise.`
    : `The brief on "${name}", as you last rewrote it on ${payload.written}.`;
  return { text: `${words}\n\n${payload.brief}`, isError: false, data: payload };
}
