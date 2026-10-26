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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDuration, parseDuration } from "../lib/duration.mjs";
import { summarize } from "../lib/metrics.mjs";
import { run as scripted } from "./adapters/scripted.mjs";
import { run as cli } from "./adapters/cli.mjs";

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
const capMs = parseDuration(flag("--cap", `${Math.ceil((budgetMs * 2) / 1000)}s`));

if (!["session", "refusal"].includes(scenario)) {
  console.error(`unknown scenario: ${scenario} (session or refusal)`);
  process.exit(64);
}
if (!["scripted", "cli"].includes(adapterName)) {
  console.error(`unknown adapter: ${adapterName} (scripted or cli)`);
  process.exit(64);
}

const adapter = adapterName === "cli" ? cli : scripted;
const tasks = JSON.parse(readFileSync(taskFile, "utf8"));
const records = [];

function makeWorkDir(task) {
  const dir = mkdtempSync(join(tmpdir(), "time-bench-"));
  for (const [name, content] of Object.entries(task.files ?? {})) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
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

if (scenario === "session") {
  for (const arm of arms) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const sessionStart = Date.now();
      const sessionBudgetMs = budgetMs;
      for (const task of tasks) {
        const remainingMs = sessionStart + sessionBudgetMs - Date.now();
        if (remainingMs <= 0) break;
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
  `\n${scenario} · ${adapterName} · ${tasks.length} tasks · ${repeats} repeat(s) · ` +
    `budget ${scenario === "session" ? formatDuration(budgetMs) : "80% of each task"}\n`,
);
const header = ["arm", "n", "started", "premature", "starved", "completed", "overran", "median overrun", "utilisation"];
const table = [
  header,
  ...rows.map((row) => [
    row.arm,
    String(row.n),
    String(row.started),
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

if (out) {
  const payload = {
    generatedAt: new Date().toISOString(),
    scenario,
    adapter: adapterName,
    budgetMs,
    reserveMs,
    repeats,
    tasks: tasks.map((t) => ({ id: t.id, class: t.class, trueCostMs: t.trueCostMs })),
    summary: rows,
    records,
  };
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
