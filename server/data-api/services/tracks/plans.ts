import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(process.cwd(), "..");
const tracksRoot = resolve(repoRoot, "tracks");
const plansDir = resolve(tracksRoot, "_plans");
const globalPromptPath = resolve(tracksRoot, "_briefing_prompt.md");
const researchDir = resolve(repoRoot, "tools/pipelines/research_tracks");
const defaultPython = resolve(researchDir, ".venv/bin/python");

type RawPlanEntry = {
  track_id: string;
  track_name?: string;
  decision?: string;
  note?: string | null;
  justification?: string | null;
  suggested_actions?: string[];
  questions?: string[];
  confidence?: number | null;
  signals: RawSignalSummary[];
};

type RawSignalSummary = {
  segment_id: string;
  logical_day: string;
  source_type: string;
  title: string;
  excerpt: string;
  score?: number | null;
  rationale?: string | null;
};

export type PlanSummary = {
  planId: string;
  createdAt: string | null;
  startDate: string | null;
  endDate: string | null;
  trackCount: number;
};

export type BriefingInfo = {
  exists: boolean;
  path?: string;
  updatedAt?: string;
};

export type BriefingPromptInfo = {
  path: string;
  updatedAt?: string;
  content: string;
};

export type ReportInfo = {
  exists: boolean;
  path?: string;
  updatedAt?: string;
};

export type StageStatus = {
  key: string;
  label: string;
  state: "pending" | "ready" | "done" | "attention" | "blocked" | "skipped";
  summary: string;
  detail?: string;
};

export type TrackWorkflow = {
  trackId: string;
  trackName: string;
  decision: string;
  note?: string | null;
  justification?: string | null;
  signalCount: number;
  sourceCounts: Record<string, number>;
  briefing: BriefingInfo;
  report: ReportInfo;
  researchLog: ReportInfo;
  stages: StageStatus[];
  signals: RawSignalSummary[];
};

export type PlanDetail = {
  planId: string;
  createdAt: string | null;
  startDate: string | null;
  endDate: string | null;
  entries: TrackWorkflow[];
};

export type BriefingContext = {
  perspective: string | null;
  previousBriefings: { planId: string; path: string; updatedAt?: string; excerpt: string }[];
  otherPerspectives: { trackId: string; trackName?: string; perspective: string }[];
  entry: TrackWorkflow;
  savedPrompt: string | null;
};

function trackPromptPath(trackId: string): string {
  return resolve(tracksRoot, trackId, "briefings", "_prompt.md");
}

function resolvePlanPath(planId: string): string {
  return resolve(plansDir, `${planId}.json`);
}


async function readJson(path: string): Promise<any> {
  const content = await fs.readFile(path, "utf8");
  return JSON.parse(content);
}

async function statIfExists(path: string): Promise<{ exists: boolean; mtime?: Date }> {
  try {
    const stats = await fs.stat(path);
    return { exists: true, mtime: stats.mtime };
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function listPlanFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(plansDir);
    return entries.filter((entry) => entry.endsWith(".json"));
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function listPlanSummaries(): Promise<PlanSummary[]> {
  const files = await listPlanFiles();
  const summaries: PlanSummary[] = [];
  for (const file of files) {
    const planPath = resolve(plansDir, file);
    try {
      const data = await readJson(planPath);
      summaries.push({
        planId: data.plan_id ?? file.replace(/\.json$/, ""),
        createdAt: data.created_at ?? null,
        startDate: data.start_date ?? null,
        endDate: data.end_date ?? null,
        trackCount: Array.isArray(data.entries) ? data.entries.length : 0,
      });
    } catch (err) {
      console.warn(`Failed to parse plan ${file}:`, err);
    }
  }
  summaries.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });
  return summaries;
}

function signalSourceCounts(signals: RawSignalSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signal of signals) {
    const key = signal.source_type || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function briefingInfo(trackId: string, planId: string): Promise<BriefingInfo> {
  const path = resolve(tracksRoot, trackId, "briefings", `${planId}.md`);
  const stats = await statIfExists(path);
  if (!stats.exists) {
    return { exists: false };
  }
  return {
    exists: true,
    path,
    updatedAt: stats.mtime?.toISOString(),
  };
}

async function deepResearchReportInfo(trackId: string, planId: string): Promise<ReportInfo> {
  const path = resolve(tracksRoot, trackId, "reports", `${planId}.md`);
  const stats = await statIfExists(path);
  if (!stats.exists) {
    return { exists: false };
  }
  return {
    exists: true,
    path,
    updatedAt: stats.mtime?.toISOString(),
  };
}

async function researchLogInfo(trackId: string, planId: string): Promise<ReportInfo> {
  const path = resolve(tracksRoot, trackId, "reports", `${planId}.research.md`);
  const stats = await statIfExists(path);
  if (!stats.exists) {
    return { exists: false };
  }
  return {
    exists: true,
    path,
    updatedAt: stats.mtime?.toISOString(),
  };
}

export async function readBriefing(trackId: string, planId: string): Promise<{ path: string; content: string; updatedAt?: string } | null> {
  const info = await briefingInfo(trackId, planId);
  if (!info.exists || !info.path) {
    return null;
  }
  const content = await fs.readFile(info.path, "utf8");
  return { path: info.path, content, updatedAt: info.updatedAt };
}

export async function writeBriefing(trackId: string, planId: string, content: string): Promise<BriefingInfo> {
  const dir = resolve(tracksRoot, trackId, "briefings");
  await fs.mkdir(dir, { recursive: true });
  const path = resolve(dir, `${planId}.md`);
  await fs.writeFile(path, content, "utf8");
  const stats = await fs.stat(path);
  return { exists: true, path, updatedAt: stats.mtime.toISOString() };
}

export async function readReport(trackId: string, planId: string): Promise<{ path: string; content: string; updatedAt?: string } | null> {
  const info = await deepResearchReportInfo(trackId, planId);
  if (!info.exists || !info.path) {
    return null;
  }
  const content = await fs.readFile(info.path, "utf8");
  return { path: info.path, content, updatedAt: info.updatedAt };
}

export async function readReportHtml(trackId: string, planId: string): Promise<string | null> {
  const htmlPath = resolve(tracksRoot, trackId, "reports", `${planId}.html`);
  try {
    return await fs.readFile(htmlPath, "utf8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function readPerspective(trackId: string): Promise<string | null> {
  const path = resolve(tracksRoot, trackId, "perspective.md");
  try {
    const text = await fs.readFile(path, "utf8");
    return text;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function recentBriefings(trackId: string, limit = 3): Promise<{ planId: string; path: string; updatedAt?: string; excerpt: string }[]> {
  const dir = resolve(tracksRoot, trackId, "briefings");
  try {
    const entries = await fs.readdir(dir);
    const files = await Promise.all(
      entries
        .filter((name) => name.endsWith(".md"))
        .map(async (name) => {
          const path = resolve(dir, name);
          const stat = await fs.stat(path);
          return { path, mtime: stat.mtime };        })
    );
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const selected = files.slice(0, limit);
    const results = [];
    for (const file of selected) {
      const content = await fs.readFile(file.path, "utf8");
      results.push({
        planId: file.path.split("/").pop()?.replace(/\.md$/, "") || file.path,
        path: file.path,
        updatedAt: file.mtime.toISOString(),
        excerpt: content.slice(0, 800),
      });
    }
    return results;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function generateBriefing(planId: string, trackId: string, prompt?: string): Promise<void> {
  const planPath = resolvePlanPath(planId);
  await fs.access(planPath);

  // If no prompt provided, read from the per-track prompt (fallback to global)
  let effectivePrompt = prompt;
  if (!effectivePrompt) {
    effectivePrompt = (await readBriefingPrompt(trackId)) ?? undefined;
  } else {
    await writeBriefingPrompt(trackId, effectivePrompt);
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const pythonBin = process.env.RESEARCH_PYTHON || defaultPython;
    const args = [
      "-m",
      "research_tracks.cli",
      "research",
      "--plan-file",
      planPath,
      "--track",
      trackId,
    ];
    const env = { ...process.env };
    if (effectivePrompt) {
      env.AKITA_BRIEFING_PROMPT = effectivePrompt;
    } else {
      delete env.AKITA_BRIEFING_PROMPT;
    }
    const proc = spawn(pythonBin, args, {
      cwd: researchDir,
      env,
      stdio: "inherit",
    });
    proc.on("error", rejectPromise);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Research CLI exited with code ${code}`));
      }
    });
  });
}

export async function generateReport(planId: string, trackId: string, options?: { force?: boolean }): Promise<void> {
  const planPath = resolvePlanPath(planId);
  await fs.access(planPath);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const pythonBin = process.env.RESEARCH_PYTHON || defaultPython;
    const args = [
      "-m",
      "research_tracks.cli",
      "deep-research",
      "--plan-file",
      planPath,
      "--track",
      trackId,
      ...(options?.force ? ["--force"] : []),
    ];
    const env = { ...process.env };
    delete env.AKITA_BRIEFING_PROMPT;
    const proc = spawn(pythonBin, args, {
      cwd: researchDir,
      env,
      stdio: "inherit",
    });
    proc.on("error", rejectPromise);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Deep research CLI exited with code ${code}`));
      }
    });
  });
}

export async function exportDeepResearchPrompt(
  planId: string,
  trackId: string,
): Promise<{ path: string; content: string } | null> {
  const planPath = resolvePlanPath(planId);
  await fs.access(planPath);

  const promptPath = resolve(tracksRoot, trackId, "reports", `${planId}_prompt.md`);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const pythonBin = process.env.RESEARCH_PYTHON || defaultPython;
    const args = [
      "-m",
      "research_tracks.cli",
      "deep-research",
      "--plan-file",
      planPath,
      "--track",
      trackId,
      "--export-prompt",
    ];
    const env = { ...process.env };
    delete env.AKITA_BRIEFING_PROMPT;
    const proc = spawn(pythonBin, args, {
      cwd: researchDir,
      env,
      stdio: "inherit",
    });
    proc.on("error", rejectPromise);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Export prompt CLI exited with code ${code}`));
      }
    });
  });

  // Read the generated prompt file
  try {
    const content = await fs.readFile(promptPath, "utf8");
    return { path: promptPath, content };
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function writeBriefingPrompt(trackId: string, content: string): Promise<BriefingPromptInfo> {
  const dir = resolve(tracksRoot, trackId, "briefings");
  await fs.mkdir(dir, { recursive: true });
  const path = trackPromptPath(trackId);
  await fs.writeFile(path, content, "utf8");
  const stat = await fs.stat(path);
  return { path, updatedAt: stat.mtime.toISOString(), content };
}

async function readBriefingPrompt(trackId: string): Promise<string | null> {
  const perTrack = trackPromptPath(trackId);
  try {
    return await fs.readFile(perTrack, "utf8");
  } catch (err: any) {
    if (!(err && err.code === "ENOENT")) {
      throw err;
    }
  }
  try {
    return await fs.readFile(globalPromptPath, "utf8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function getBriefingContext(planId: string, trackId: string): Promise<BriefingContext | null> {
  const plan = await readPlanDetail(planId);
  if (!plan) {
    return null;
  }
  const entry = plan.entries.find((item) => item.trackId === trackId);
  if (!entry) {
    return null;
  }
  const perspective = await readPerspective(trackId);
  const briefs = await recentBriefings(trackId);
  const savedPrompt = await readBriefingPrompt(trackId);
  const otherPerspectives: { trackId: string; trackName?: string; perspective: string }[] = [];
  for (const other of plan.entries) {
    if (other.trackId === trackId) {
      continue;
    }
    const text = await readPerspective(other.trackId);
    if (!text) {
      continue;
    }
    otherPerspectives.push({ trackId: other.trackId, trackName: other.trackName, perspective: text });
  }
  return {
    perspective,
    previousBriefings: briefs,
    otherPerspectives,
    entry,
    savedPrompt,
  };
}

function planStageSummary(plan: PlanDetail): StageStatus {
  const window = plan.startDate && plan.endDate ? `${plan.startDate} → ${plan.endDate}` : undefined;
  return {
    key: "plan",
    label: "Plan",
    state: "done",
    summary: `Plan ${plan.planId}`,
    detail: window,
  };
}

function planDecisionStage(decision: string, note?: string | null): StageStatus {
  if (!decision || decision === "pending") {
    return {
      key: "plan_review",
      label: "Edit Plan",
      state: "attention",
      summary: "Decision needed",
      detail: "Choose research / monitor / skip.",
    };
  }
  return {
    key: "plan_review",
    label: "Edit Plan",
    state: "done",
    summary: `Decision: ${decision}`,
    detail: note || undefined,
  };
}

function classificationStage(signalCount: number, sourceCounts: Record<string, number>): StageStatus {
  const summary = signalCount === 1 ? "1 signal" : `${signalCount} signals`;
  const detail = Object.entries(sourceCounts)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
  return {
    key: "classification",
    label: "Classification",
    state: signalCount ? "done" : "pending",
    summary,
    detail: detail || undefined,
  };
}

function briefingStages(decision: string, briefing: BriefingInfo): StageStatus[] {
  if (decision === "skip") {
    return [
      {
        key: "briefing",
        label: "Briefing",
        state: "skipped",
        summary: "Skipped",
        detail: "Track skipped per plan.",
      },
      {
        key: "research",
        label: "Research",
        state: "skipped",
        summary: "Skipped",
        detail: "Track skipped per plan.",
      },
    ];
  }
  if (decision === "monitor") {
    return [
      {
        key: "briefing",
        label: "Briefing",
        state: "ready",
        summary: "Monitoring",
        detail: "Briefing optional.",
      },
      {
        key: "research",
        label: "Research",
        state: "ready",
        summary: "Monitoring",
        detail: "Keep an eye on future signals.",
      },
    ];
  }
  if (!briefing.exists) {
    return [
      {
        key: "briefing",
        label: "Briefing",
        state: "attention",
        summary: "No briefing",
        detail: "Run research to draft briefing.",
      },
      {
        key: "research",
        label: "Research",
        state: "pending",
        summary: "Awaiting briefing",
        detail: "Generate a briefing before deep dives.",
      },
    ];
  }
  return [
    {
      key: "briefing",
      label: "Briefing",
      state: "done",
      summary: briefing.path ? briefing.path.split("/").pop() ?? "Briefing" : "Briefing ready",
      detail: briefing.updatedAt ? `Updated ${briefing.updatedAt}` : undefined,
    },
    {
      key: "research",
      label: "Research",
      state: "ready",
      summary: "Ready for deep research",
      detail: "Briefing completed.",
    },
  ];
}

function deepResearchStages(decision: string, briefing: BriefingInfo, report: ReportInfo, signalCount: number): StageStatus[] {
  if (decision === "skip") {
    return [
      {
        key: "deep_research",
        label: "Deep Research",
        state: "skipped",
        summary: "Skipped",
        detail: "Track skipped per plan.",
      },
    ];
  }
  if (decision === "monitor") {
    return [
      {
        key: "deep_research",
        label: "Deep Research",
        state: "skipped",
        summary: "Monitoring",
        detail: "Deep research optional for monitoring tracks.",
      },
    ];
  }
  // Zero-signal entries: allow force-run without requiring briefing
  if (signalCount === 0) {
    if (report.exists) {
      return [
        {
          key: "deep_research",
          label: "Deep Research",
          state: "done",
          summary: report.path ? report.path.split("/").pop() ?? "Report" : "Report",
          detail: report.updatedAt ? `Updated ${report.updatedAt}` : undefined,
        },
      ];
    }
    return [
      {
        key: "deep_research",
        label: "Deep Research",
        state: "ready",
        summary: "No signals — force available",
        detail: "Force deep research for this watch track.",
      },
    ];
  }
  if (!briefing.exists) {
    return [
      {
        key: "deep_research",
        label: "Deep Research",
        state: "blocked",
        summary: "No briefing",
        detail: "Generate a briefing before deep research.",
      },
    ];
  }
  if (!report.exists) {
    return [
      {
        key: "deep_research",
        label: "Deep Research",
        state: "pending",
        summary: "No report",
        detail: "Run deep research to capture findings.",
      },
    ];
  }
  return [
    {
      key: "deep_research",
      label: "Deep Research",
      state: "done",
      summary: report.path ? report.path.split("/").pop() ?? "Report" : "Report",
      detail: report.updatedAt ? `Updated ${report.updatedAt}` : undefined,
    },
  ];
}

function buildWorkflow(entry: RawPlanEntry, plan: PlanDetail, briefing: BriefingInfo, report: ReportInfo, researchLog: ReportInfo): TrackWorkflow {
  const signalCount = Array.isArray(entry.signals) ? entry.signals.length : 0;
  const sourceCounts = signalSourceCounts(entry.signals || []);
  const decision = (entry.decision || "pending").toLowerCase();
  const stages: StageStatus[] = [classificationStage(signalCount, sourceCounts)];
  stages.push(planStageSummary(plan));
  stages.push(planDecisionStage(decision, entry.note));
  stages.push(...briefingStages(decision, briefing));
  stages.push(...deepResearchStages(decision, briefing, report, signalCount));

  return {
    trackId: entry.track_id,
    trackName: entry.track_name || entry.track_id,
    decision,
    note: entry.note ?? null,
    justification: entry.justification ?? null,
    signalCount,
    sourceCounts,
    briefing,
    report,
    researchLog,
    stages,
    signals: entry.signals ?? [],
  };
}

export async function readPlanDetail(planId: string): Promise<PlanDetail | null> {
  const planPath = resolvePlanPath(planId);
  try {
    const data = await readJson(planPath);
    const plan: PlanDetail = {
      planId: data.plan_id ?? planId,
      createdAt: data.created_at ?? null,
      startDate: data.start_date ?? null,
      endDate: data.end_date ?? null,
      entries: [],
    };
    if (Array.isArray(data.entries)) {
      for (const entry of data.entries as RawPlanEntry[]) {
        const briefing = await briefingInfo(entry.track_id, plan.planId);
        const report = await deepResearchReportInfo(entry.track_id, plan.planId);
        const log = await researchLogInfo(entry.track_id, plan.planId);
        plan.entries.push(buildWorkflow(entry, plan, briefing, report, log));
      }
    }
    return plan;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function updatePlanEntryDecision(
  planId: string,
  trackId: string,
  updates: { decision?: string; note?: string | null; justification?: string | null },
): Promise<TrackWorkflow | null> {
  const planPath = resolvePlanPath(planId);
  let data: any;
  try {
    data = await readJson(planPath);
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const entries: RawPlanEntry[] = Array.isArray(data.entries) ? data.entries : [];
  const entry = entries.find((item) => item.track_id === trackId);
  if (!entry) {
    return null;
  }
  if (typeof updates.decision === "string") {
    entry.decision = updates.decision;
  }
  if (updates.note !== undefined) {
    entry.note = updates.note;
  }
  if (updates.justification !== undefined) {
    entry.justification = updates.justification;
  }
  data.entries = entries;
  await fs.writeFile(planPath, JSON.stringify(data, null, 2));
  const planDetail = await readPlanDetail(planId);
  if (!planDetail) {
    return null;
  }
  return planDetail.entries.find((item) => item.trackId === trackId) ?? null;
}

export type DigestInfo = {
  exists: boolean;
  path?: string;
  content?: string;
  updatedAt?: string;
};

export async function readDigest(planId: string): Promise<DigestInfo> {
  const digestPath = resolve(tracksRoot, "_digests", `${planId}.md`);
  const stats = await statIfExists(digestPath);
  if (!stats.exists) {
    return { exists: false };
  }
  try {
    const content = await fs.readFile(digestPath, "utf8");
    return {
      exists: true,
      path: digestPath,
      content,
      updatedAt: stats.mtime?.toISOString(),
    };
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

export async function generateDigest(planId: string): Promise<DigestInfo> {
  const planPath = resolvePlanPath(planId);
  await fs.access(planPath);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const pythonBin = process.env.RESEARCH_PYTHON || defaultPython;
    const args = [
      "-m",
      "research_tracks.cli",
      "digest",
      "--plan-file",
      planPath,
    ];
    const proc = spawn(pythonBin, args, {
      cwd: researchDir,
      env: { ...process.env },
      stdio: "inherit",
    });
    proc.on("error", rejectPromise);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Digest CLI exited with code ${code}`));
      }
    });
  });

  return readDigest(planId);
}

export async function deletePlan(planId: string): Promise<{ deleted: boolean }> {
  const planPath = resolvePlanPath(planId);
  try {
    await fs.unlink(planPath);
    return { deleted: true };
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { deleted: false };
    }
    throw err;
  }
}
