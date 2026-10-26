#!/usr/bin/env node
// The supervisor. It owns the clock, writes the timer state the agent is allowed
// to read, and records what happened from outside the agent's process.
//
//   node bench/run.mjs --adapter scripted --budget 10s --out bench/results/demo.json
//   node bench/run.mjs --scenario refusal --adapter scripted --tasks bench/tasks/demo.json
//   node bench/run.mjs --adapter cli --cmd "codex exec --skip-git-repo-check --ephemeral -s workspace-write" \
//     --tasks bench/tasks/refusal.json --scenario refusal --budget 30s --repeats 3
//
// Scenarios
//   session   one shared pot of time, tasks taken in order until it is gone
//   refusal   one task per session, with less time left than the task costs, so a
//             gate that works must decline. This is the cheapest headline: does
//             the agent start what it cannot finish?
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDuration, parseDuration } from "../lib/duration.mjs";
import { summarize } from "../lib/metrics.mjs";
import { run as scripted, runSession as scriptedSession } from "./adapters/scripted.mjs";
import { run as cli } from "./adapters/cli.mjs";
import { run as cliSession } from "./adapters/session.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const eq = args.find((a) => a === name || a.startsWith(`${name}=`));
  if (eq === undefined) return fallback;
  if (eq.includes("=")) return eq.slice(eq.indexOf("=") + 1);
  return args[args.indexOf(eq) + 1];
};

const tool = new URL("../time.mjs", import.meta.url).pathname;
const taskFile = flag("--tasks", new URL("./tasks/demo.json", import.meta.url).pathname);
const scenario = flag("--scenario", "session");
const adapterName = flag("--adapter", "scripted");
const budgetMs = parseDuration(flag("--budget", "10s"));
const reserveMs = parseDuration(flag("--reserve", "1000ms"));
const repeats = Number(flag("--repeats", "1"));
const out = flag("--out", null);
const cmd = (flag("--cmd", "codex exec --skip-git-repo-check --ephemeral -s workspace-write") || "")
  .split(" ")
  .filter(Boolean);
const arms = (flag("--arms", "blind,aware,gated") || "").split(",");
const invocation = flag("--invocation", "per-task");
// One invocation per session pays the agent's startup once, so the cap has to
// allow for a session's worth of thinking rather than a single decision's.
const capDefault =
  invocation === "per-session"
    ? `${Math.ceil((budgetMs + Math.max(240_000, budgetMs)) / 1000)}s`
    : `${Math.ceil((budgetMs * 2) / 1000)}s`;
const capMs = parseDuration(flag("--cap", capDefault));
// Multiplies the cost the agent is told, leaving the measured cost alone: a run
// with 2.6 models the forecast miss AgentTime found instead of a perfect estimate.
const estimateScale = Number(flag("--estimate-scale", "1"));
if (!Number.isFinite(estimateScale) || estimateScale <= 0) {
  console.error(`--estimate-scale must be a positive number (got ${flag("--estimate-scale", "1")})`);
  process.exit(64);
}
// A `gated-cal` arm reads its costs from a ledger, so the ledger has to come from
// somewhere with measurements in it: a previous result file, one entry per task.
const calibrationFrom = flag("--calibration-from", null);
// A real ledger is noisy and class-level, not a table of exact task costs. Jitter
// makes the seed look like history instead of hindsight, deterministically so the
// same seed file and factor always produce the same ledger.
const calibrationJitter = Number(flag("--calibration-jitter", "0"));
if (!Number.isFinite(calibrationJitter) || calibrationJitter < 0 || calibrationJitter >= 1) {
  console.error(`--calibration-jitter must be in [0, 1) (got ${flag("--calibration-jitter", "0")})`);
  process.exit(64);
}
const jitterFor = (taskId) => {
  if (calibrationJitter === 0) return 1;
  let hash = 2166136261;
  for (const char of taskId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const unit = (hash % 10_000) / 10_000;
  return 1 + (unit * 2 - 1) * calibrationJitter;
};
const calibrationRecords = calibrationFrom
  ? (JSON.parse(readFileSync(calibrationFrom, "utf8")).records ?? [])
  : [];
if (arms.includes("gated-cal") && calibrationRecords.length === 0) {
  console.error("the gated-cal arm needs --calibration-from <a previous result.json>");
  process.exit(64);
}

if (!["session", "refusal"].includes(scenario)) {
  console.error(`unknown scenario: ${scenario} (session or refusal)`);
  process.exit(64);
}
if (!["scripted", "cli"].includes(adapterName)) {
  console.error(`unknown adapter: ${adapterName} (scripted or cli)`);
  process.exit(64);
}
if (!["per-task", "per-session"].includes(invocation)) {
  console.error(`unknown invocation: ${invocation} (per-task or per-session)`);
  process.exit(64);
}
if (invocation === "per-session" && scenario !== "session") {
  console.error("per-session only applies to the session scenario");
  process.exit(64);
}

const adapter = adapterName === "cli" ? cli : scripted;
const sessionAdapter = adapterName === "cli" ? cliSession : scriptedSession;
const tasks = JSON.parse(readFileSync(taskFile, "utf8"));
const records = [];

function makeWorkDir(task) {
  const dir = mkdtempSync(join(tmpdir(), "time-bench-"));
  for (const [name, content] of Object.entries(task.files ?? {})) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// One plan/done pair per task measured in the seed run, so `check --for <class>`
// has real durations to take its p90 from.
function writeLedger(dir) {
  const seen = new Map();
  for (const record of calibrationRecords) {
    if (seen.has(record.taskId)) continue;
    seen.set(record.taskId, record);
  }
  const path = join(dir, ".time", "ledger.jsonl");
  mkdirSync(join(dir, ".time"), { recursive: true });
  const lines = [];
  let index = 0;
  for (const [taskId, record] of seen) {
    const at = 1_700_000_000_000 + index * 1000;
    lines.push(
      JSON.stringify({
        type: "plan",
        id: taskId,
        label: taskId,
        class: record.class,
        estimateMs: record.declaredCostMs ?? record.trueCostMs,
        at,
      }),
    );
    lines.push(
      JSON.stringify({
        type: "done",
        id: taskId,
        at: at + 1,
        actualMs: Math.round(record.trueCostMs * jitterFor(taskId)),
        status: "ok",
      }),
    );
    index++;
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function writeState(dir, sessionStart, sessionBudgetMs) {
  const statePath = join(dir, ".timer-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({ start: sessionStart, minutes: sessionBudgetMs / 60_000 }),
  );
  return statePath;
}

async function runOne({ task, arm, sessionStart, sessionBudgetMs, remainingMs, sessionId }) {
  const workDir = makeWorkDir(task);
  const statePath = writeState(workDir, sessionStart, sessionBudgetMs);
  const result = await adapter({
    task,
    arm,
    tool,
    statePath,
    workDir,
    reserveMs,
    cmd,
    capMs,
  });
  const record = {
    taskId: task.id,
    class: task.class ?? "untagged",
    arm,
    scenario,
    sessionId,
    adapter: adapterName,
    budgetMs: sessionBudgetMs,
    reserveMs,
    remainingAtStartMs: Math.max(0, remainingMs),
    afterExpiry: remainingMs <= 0,
    trueCostMs: task.trueCostMs,
    started: result.started,
    finished: result.finished,
    runtimeMs: result.runtimeMs,
    overranBudget: result.started && result.runtimeMs > Math.max(0, remainingMs),
    note: result.note,
  };
  if (result.agentOutput) record.agentOutput = result.agentOutput;
  return record;
}

// One invocation, many decisions: the adapter runs the whole session and reports
// each task's markers, so the record is built from when the work actually began
// rather than from when the supervisor handed over the next prompt.
function sessionRecord({ task, arm, sessionId, sessionBudgetMs, result }) {
  return {
    taskId: task.id,
    class: task.class ?? "untagged",
    arm,
    scenario,
    sessionId,
    adapter: adapterName,
    invocation,
    budgetMs: sessionBudgetMs,
    reserveMs,
    remainingAtStartMs: Math.max(0, result.remainingAtStartMs),
    afterExpiry: result.remainingAtStartMs <= 0,
    trueCostMs: task.trueCostMs,
    declaredCostMs: Math.round(task.trueCostMs * estimateScale),
    started: result.started,
    finished: result.finished,
    runtimeMs: result.runtimeMs,
    overranBudget: result.started && result.runtimeMs > Math.max(0, result.remainingAtStartMs),
    note: result.note,
  };
}

const sessionLogs = [];

if (scenario === "session" && invocation === "per-session") {
  for (const arm of arms) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const sessionStart = Date.now();
      const sessionId = `${arm}-${repeat}`;
      const workDir = mkdtempSync(join(tmpdir(), "time-session-"));
      const statePath = writeState(workDir, sessionStart, budgetMs);
      const ledgerPath = calibrationRecords.length > 0 ? writeLedger(workDir) : null;
      const outcome = await sessionAdapter({
        tasks,
        arm,
        tool,
        statePath,
        workDir,
        reserveMs,
        cmd,
        capMs,
        sessionStart,
        sessionBudgetMs: budgetMs,
        estimateScale,
        ledgerPath,
      });
      for (const result of outcome.results) {
        records.push(
          sessionRecord({ task: tasks.find((t) => t.id === result.taskId), arm, sessionId, sessionBudgetMs: budgetMs, result }),
        );
      }
      sessionLogs.push({
        sessionId,
        arm,
        wallClockMs: Date.now() - sessionStart,
        killed: outcome.killed ?? false,
        exitCode: outcome.code ?? 0,
        agentOutput: outcome.agentOutput,
      });
    }
  }
} else if (scenario === "session") {
  for (const arm of arms) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const sessionStart = Date.now();
      const sessionBudgetMs = budgetMs;
      // Every arm is offered every task, even after the pot is empty: "did it keep
      // starting work with nothing left?" is the sharpest form of the question,
      // and stopping early would hide it behind a truncated session.
      for (const task of tasks) {
        const remainingMs = sessionStart + sessionBudgetMs - Date.now();
        records.push(
          await runOne({
            task,
            arm,
            sessionStart,
            sessionBudgetMs,
            remainingMs,
            sessionId: `${arm}-${repeat}`,
          }),
        );
      }
    }
  }
} else {
  // Every task is offered with 80% of its own cost left, so starting it is always
  // a mistake and declining it is always correct.
  for (const arm of arms) {
    for (const task of tasks) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        const sessionBudgetMs = Math.floor(task.trueCostMs * 0.8);
        const sessionStart = Date.now();
        records.push(
          await runOne({
            task,
            arm,
            sessionStart,
            sessionBudgetMs,
            remainingMs: sessionBudgetMs,
            sessionId: `${arm}-${task.id}-${repeat}`,
          }),
        );
      }
    }
  }
}

const rows = summarize(records);
const pct = (value) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const brief = (ms) => (ms === null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms));

console.log(
  `\n${scenario} · ${adapterName} · ${invocation} · ${tasks.length} tasks · ${repeats} repeat(s) · ` +
    `budget ${scenario === "session" ? formatDuration(budgetMs) : "80% of each task"}\n`,
);
const header = ["arm", "n", "started", "after expiry", "premature", "starved", "completed", "overran", "median overrun", "utilisation"];
const table = [
  header,
  ...rows.map((row) => [
    row.arm,
    String(row.n),
    String(row.started),
    String(row.startedAfterExpiry),
    `${row.prematureStarts} (${pct(row.prematureStartRate)})`,
    `${row.starvedRefusals} (${pct(row.starvedRefusalRate)})`,
    String(row.completed),
    String(row.overranBudget),
    brief(row.medianOverrunMs),
    pct(row.utilisation),
  ]),
];
const widths = header.map((_, column) => Math.max(...table.map((line) => line[column].length)));
for (const [index, line] of table.entries()) {
  console.log(line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
  if (index === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
}
console.log(
  "\npremature = started work that could not be finished and verified in the time left." +
    "\nstarved   = declined work that would have fit, reserve included. Read the two together." +
    "\nstarted   can exceed n for refused tasks: a refusal costs no time, so the session goes on.\n",
);

// The confound that moved E2's numbers: time spent deciding, charged to the same
// pot as the work. It is cheap here to report it per arm, and the instrument that
// changes its own result should measure the term that changed it.
if (sessionLogs.length > 0) {
  console.log("deciding time = session wall clock minus work, per decision taken:");
  for (const arm of arms) {
    const logs = sessionLogs.filter((log) => log.arm === arm);
    const wallMs = logs.reduce((sum, log) => sum + log.wallClockMs, 0);
    const armRecords = records.filter((record) => record.arm === arm);
    const workMs = armRecords.reduce((sum, record) => sum + record.runtimeMs, 0);
    const decisions = armRecords.filter((record) => record.started).length;
    const pastBellMs = logs.reduce((sum, log) => sum + Math.max(0, log.wallClockMs - budgetMs), 0);
    console.log(
      `  ${arm.padEnd(6)} ${logs.length} session(s) · wall ${(wallMs / 1000).toFixed(1)}s · ` +
        `${(pastBellMs / 1000).toFixed(1)}s past the bell · ` +
        `${decisions === 0 ? "—" : `${((wallMs - workMs) / decisions / 1000).toFixed(1)}s per decision`}`,
    );
  }
  console.log("");
}

if (out) {
  const payload = {
    generatedAt: new Date().toISOString(),
    scenario,
    adapter: adapterName,
    invocation,
    capMs,
    budgetMs,
    reserveMs,
    estimateScale,
    calibrationFrom,
    calibrationJitter,
    repeats,
    tasks: tasks.map((t) => ({ id: t.id, class: t.class, trueCostMs: t.trueCostMs })),
    summary: rows,
    sessions: sessionLogs,
    records,
  };
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
