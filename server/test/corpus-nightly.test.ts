// The corpus reconciles itself every night (services/corpusNightly.ts). What
// these pin down is the shape of the safety net rather than the corpus's own
// work: one reconcile call for the household, a prune per member, a night
// that fails is recorded as such, a run in flight is shared, and "due" means
// once per local day from the hour on — never twice, never skipped.

import { expect, test } from "bun:test";

const { isDue, reconcileCorpus, corpusNightlyStatus, nightlyOn } = await import("../src/services/corpusNightly");

function fakeDeps(opts: { fail?: string; pruneFail?: string } = {}) {
  const calls: { member: string; tool: string; args: any }[] = [];
  const members = [{ id: "m-anna" }, { id: "m-ben" }, { id: "m-child" }];
  const call = async (member: string, tool: string, args: any) => {
    calls.push({ member, tool, args });
    if (tool === "index_conversation") {
      if (opts.fail) throw new Error(opts.fail);
      return { conversations: 42, chunks_written: 7 };
    }
    if (tool === "prune") {
      if (opts.pruneFail === member) return { error: "boom" };
      return { scanned: 10, removed: member === "m-ben" ? 2 : 0 };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { calls, deps: { call, members: () => members } };
}

test("off under test, and by the switch", () => {
  expect(nightlyOn()).toBe(false);
});

test("due once per local day, from the hour on", () => {
  const at = (h: number, day = 19) => new Date(2026, 8, day, h, 5);
  expect(isDue(at(2), null)).toBe(false); // before the hour, even with no run ever
  expect(isDue(at(3), null)).toBe(true);
  expect(isDue(at(3), at(3, 18).toISOString())).toBe(true); // yesterday's run
  expect(isDue(at(9), at(3).toISOString())).toBe(false); // already ran today
  expect(isDue(at(23), at(3).toISOString())).toBe(false);
  expect(isDue(at(4), "not a date")).toBe(true); // a broken record costs one run
});

test("one reconcile for the household, one prune per member, counted", async () => {
  const { calls, deps } = fakeDeps();
  const outcome = await reconcileCorpus(deps);
  expect(outcome).toBe("reconciled");
  expect(calls.map((c) => c.tool)).toEqual(["index_conversation", "prune", "prune", "prune"]);
  expect(calls[0].args).toEqual({}); // no conversation_id: every conversation
  expect(calls.slice(1).map((c) => c.member)).toEqual(["m-anna", "m-ben", "m-child"]);
  const s = corpusNightlyStatus();
  expect(s.last_outcome).toBe("reconciled");
  expect(s.last_stats).toEqual({ conversations: 42, chunks_written: 7, pruned: 2, members: 3 });
  expect(s.last_error).toBeNull();
  expect(s.running).toBe(false);
  expect(s.last_run_at && !Number.isNaN(Date.parse(s.last_run_at))).toBe(true);
});

test("a reconcile that fails is recorded, and prune is not attempted", async () => {
  const { calls, deps } = fakeDeps({ fail: "gateway down" });
  expect(await reconcileCorpus(deps)).toBe("failed");
  expect(calls.map((c) => c.tool)).toEqual(["index_conversation"]);
  expect(corpusNightlyStatus().last_error).toBe("gateway down");
});

test("one member's prune failing does not stop the others", async () => {
  const { calls, deps } = fakeDeps({ pruneFail: "m-anna" });
  expect(await reconcileCorpus(deps)).toBe("failed");
  expect(calls.filter((c) => c.tool === "prune").length).toBe(3);
  const s = corpusNightlyStatus();
  expect(s.last_error).toContain("prune(m-anna)");
  expect(s.last_stats?.pruned).toBe(2); // ben's two, counted despite anna's failure
});

test("a run already going is shared, not doubled", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const deps = {
    members: () => [{ id: "m-anna" }],
    call: async (_m: string, tool: string) => {
      calls.push(tool);
      if (tool === "index_conversation") await gate;
      return tool === "prune" ? { removed: 0 } : { conversations: 1, chunks_written: 0 };
    },
  };
  const first = reconcileCorpus(deps);
  const second = reconcileCorpus(deps);
  expect(corpusNightlyStatus().running).toBe(true);
  release();
  expect(await first).toBe("reconciled");
  expect(await second).toBe("reconciled");
  expect(calls.filter((t) => t === "index_conversation").length).toBe(1);
});

test("a corpus that reconciles in the background is polled until it is done", async () => {
  const calls: string[] = [];
  let polls = 0;
  const deps = {
    members: () => [{ id: "m-anna" }],
    pollMs: 5,
    call: async (_m: string, tool: string) => {
      calls.push(tool);
      if (tool === "index_conversation") return { status: "started", running: true };
      if (tool === "reconcile_status") {
        polls++;
        return polls < 3
          ? { running: true, conversations: 0, chunks_written: 0 }
          : { running: false, conversations: 5122, chunks_written: 3, error: null };
      }
      return { removed: 0 };
    },
  };
  expect(await reconcileCorpus(deps)).toBe("reconciled");
  expect(calls.filter((t) => t === "reconcile_status").length).toBe(3);
  expect(calls[calls.length - 1]).toBe("prune"); // prune waits for the pass
  expect(corpusNightlyStatus().last_stats?.conversations).toBe(5122);
});

test("a background pass that fails is reported, and one that outlasts the wait is said so", async () => {
  const failing = {
    members: () => [{ id: "m-anna" }],
    pollMs: 5,
    call: async (_m: string, tool: string) =>
      tool === "index_conversation" ? { status: "started" } : { running: false, error: "maurice.db locked" },
  };
  expect(await reconcileCorpus(failing)).toBe("failed");
  expect(corpusNightlyStatus().last_error).toBe("maurice.db locked");
  const endless = {
    members: () => [{ id: "m-anna" }],
    pollMs: 5,
    maxWaitMs: 20,
    call: async (_m: string, tool: string) => (tool === "index_conversation" ? { status: "running" } : { running: true }),
  };
  expect(await reconcileCorpus(endless)).toBe("failed");
  expect(corpusNightlyStatus().last_error).toContain("still reconciling");
});

test("a household with no members does nothing and says so", async () => {
  const { calls, deps } = fakeDeps();
  deps.members = () => [];
  expect(await reconcileCorpus(deps)).toBe("no_members");
  expect(calls.length).toBe(0);
});
