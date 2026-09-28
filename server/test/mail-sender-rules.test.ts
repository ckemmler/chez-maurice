/**
 * Senders set aside from the reading (services/mailSenderRules.ts): a rule
 * is an address and the days of its mail still read (0: none); every triage
 * carries the rules; the card names each heavy sender with its rule.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const rules = await import("../src/services/mailSenderRules");
const scan = await import("../src/services/mailScan");

const M = "rules-m";
const calls: Array<{ name: string; args: any }> = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'M', 'standard')`, [M, M]);
  db.run(`INSERT OR IGNORE INTO mail_accounts (id, member_id, address, secret, state) VALUES ('rules-acct', ?, 'm@example.org', 'v1:x', 'ok')`, [M]);
  scan.setMailScanDeps({
    call: async (_m: string, name: string, args: any) => {
      calls.push({ name, args });
      if (name === "triage_mailbox") return { counts: { bulk: 10, correspondence: 2, other: 1 } };
      if (name === "scan_status") {
        return {
          job: { state: "done" }, totals: { messages: 13 },
          mailboxes: [{ address: "m@example.org", messages: 13, untriaged: 0,
            reading: { window: 13, to_light: 0, kept: 0, skipped: 0, to_read: 0, read: 0 },
            top_senders: [{ sender: "support@desk.example", messages: 9, set_aside: 8 }, { sender: "ann@example.org", messages: 2, set_aside: 0 }] }],
        };
      }
      return {};
    },
  } as any);
});

afterAll(() => scan.setMailScanDeps(null));

test("a rule is an address and days, 0 for none, null takes it back; a bad one is refused", () => {
  expect(rules.setSenderRule(M, "Support <Support@Desk.example>", 7)).toEqual({ address: "support@desk.example", days: 7 });
  expect(rules.setSenderRule(M, "jira@tracker.example", 0)).toEqual({ address: "jira@tracker.example", days: 0 });
  expect(rules.senderRulesForTriage(M)).toEqual({ "jira@tracker.example": 0, "support@desk.example": 7 });
  expect(() => rules.setSenderRule(M, "not an address", 1)).toThrow();
  expect(() => rules.setSenderRule(M, "a@b.example", -1)).toThrow();
  expect(rules.setSenderRule(M, "jira@tracker.example", null)).toBeNull();
  expect(rules.listSenderRules(M).map((r) => r.address)).toEqual(["support@desk.example"]);
});

test("the triage carries the rules, and each named sender shows its own", async () => {
  calls.length = 0;
  await scan.retriage(M);
  const t = calls.find((c) => c.name === "triage_mailbox")!;
  expect(t.args.rules).toEqual({ "support@desk.example": 7 });
  const view = await scan.mailScanStatus(M);
  const [box] = view.mailboxes;
  expect(box!.top_senders).toEqual([
    { sender: "support@desk.example", messages: 9, set_aside: 8, rule_days: 7 },
    { sender: "ann@example.org", messages: 2, set_aside: 0, rule_days: null },
  ]);
});
