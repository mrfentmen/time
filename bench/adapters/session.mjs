// One agent invocation for a whole session, rather than one per task.
//
// E2 paid the agent's startup and thinking time once per decision, and that
// overhead (8-12s) was charged to the same pot as the work, so a 20s budget was
// mostly startup. This adapter pays it once: the agent receives the task list and
// the budget, and decides for itself what to start, in a single process. That is
// also the more realistic shape — a session is one agent carrying its context
// across decisions, not twelve strangers.
//
// Ground truth is unchanged: every task's work script writes `.started` and
// `.done` in its own directory, so the supervisor reconstructs each decision from
// files the agent cannot fake by saying "done" in its reply.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const secs = (ms) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;

// The task list is data, not prompt steering: every arm gets the same list, the
// same costs and the same commands. Only the time tool differs.
//
// `estimateScale` inflates or deflates the cost every arm is *told*. The true cost
// stays in the records; only the information the agent acts on changes, which is
// what an experiment about bad forecasts needs (E2f).
export const declaredCost = (task, scale = 1) => Math.round(task.trueCostMs * scale);

export function prompt({ tasks, arm, tool, reserveMs, workDir, estimateScale = 1 }) {
  const lines = [
    `You are working in this directory: ${workDir}`,
    "",
    "This is a work session with a fixed wall-clock budget. The tasks below are in",
    "the order they should be done. Each task is a command run from its own",
    "directory. Do as many as fit, then stop.",
    "",
    ...tasks.map(
      (task, index) =>
        `  ${index + 1}. ${task.id} (${task.class ?? "untagged"}, about ${secs(declaredCost(task, estimateScale))}): ` +
        `${task.command.join(" ")}  — run in tasks/${task.id}/`,
    ),
    "",
    "Run each command once. Do not create your own timing files or modify the task",
    "scripts.",
  ];
  if (arm === "aware") {
    lines.push(
      "",
      `You can see how much of the session budget is left: node ${tool} check`,
      "(it exits 2 once the budget is gone).",
    );
  }
  if (arm === "gated") {
    lines.push(
      "",
      "Before starting each task, run exactly this, with that task's own cost:",
      ...tasks.map(
        (task) =>
          `  ${task.id}: node ${tool} check --needs ${declaredCost(task, estimateScale)}ms --reserve ${reserveMs}ms`,
      ),
      "Exit 0 means it fits in the remaining budget; exit 2 means it does not.",
      "If it does not fit, skip that task and go on to the next one. Do not run a",
      "command whose check exited 2.",
    );
  }
  if (arm === "gated-cal") {
    lines.push(
      "",
      "The estimates above are historically unreliable. The ledger in this directory",
      "holds what tasks of each class have actually cost before. Before starting each",
      "task, run exactly this, which uses the measured cost for that class:",
      ...tasks.map(
        (task) =>
          `  ${task.id}: node ${tool} check --for ${task.class ?? "untagged"} --reserve ${reserveMs}ms`,
      ),
      "Exit 0 means it fits in the remaining budget; exit 2 means it does not.",
      "If it does not fit, skip that task and go on to the next one. Do not run a",
      "command whose check exited 2.",
    );
  }
  lines.push("", "When you are finished, reply with one line per task: id, ran or skipped.");
  return lines.join("\n");
}

// Tasks live in their own subdirectories so their markers cannot collide: one
// `.started` per task, written by that task's script.
export function materialise(tasks, workDir) {
  for (const task of tasks) {
    const dir = join(workDir, "tasks", task.id);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(task.files ?? {})) {
      writeFileSync(join(dir, name), content);
    }
  }
}

// The marker holds the timestamp the work script wrote, which is the moment the
// work began, not the moment the agent decided. Unreadable content falls back to
// the file's mtime so a task is never silently scored as not started.
function readMarker(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const stamp = Number(raw);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now();
}

// A skipped task leaves no marker, so the moment of its refusal has to be
// bounded. It happened between the previous task ending and the next one
// starting, so the later bound is used: the remaining time at the next start, or
// at the end of the session for a trailing skip. That under-reports the time the
// gate had when it said no, which is the direction that cannot flatter it.
export function readSession({ tasks, workDir, sessionEnd, sessionStart, sessionBudgetMs, reserveMs }) {
  const marks = tasks.map((task) => {
    const dir = join(workDir, "tasks", task.id);
    return { task, startedAt: readMarker(dir, ".started"), finishedAt: readMarker(dir, ".done") };
  });
  return marks.map(({ task, startedAt, finishedAt }, index) => {
    const nextStart = marks
      .slice(index + 1)
      .map((m) => m.startedAt)
      .find((stamp) => stamp !== null);
    const decisionAt = startedAt ?? nextStart ?? sessionEnd;
    const remainingAtStartMs = sessionStart + sessionBudgetMs - decisionAt;
    return {
      taskId: task.id,
      started: startedAt !== null,
      finished: startedAt !== null && finishedAt !== null,
      startedAt,
      finishedAt,
      remainingAtStartMs,
      runtimeMs:
        startedAt === null
          ? 0
          : finishedAt !== null
            ? finishedAt - startedAt
            : Math.max(0, sessionEnd - startedAt),
      reserveMs,
    };
  });
}

export async function run({
  tasks,
  arm,
  tool,
  reserveMs,
  workDir,
  cmd,
  capMs,
  statePath,
  sessionStart,
  sessionBudgetMs,
  estimateScale = 1,
  ledgerPath = null,
}) {
  materialise(tasks, workDir);
  const args = [...cmd, "-C", workDir, "-"];
  const child = spawn(cmd[0], args.slice(1), {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TIMER_STATE: statePath,
      ...(ledgerPath ? { TIME_LEDGER: ledgerPath } : {}),
    },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, capMs);

  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.stdin.end(`${prompt({ tasks, arm, tool, reserveMs, workDir, estimateScale })}\n`);
  });
  clearTimeout(timer);
  const sessionEnd = Date.now();

  return {
    code,
    killed,
    sessionEnd,
    agentOutput: out.trim().slice(-1200),
    agentStderrTail: err.trim().slice(-300),
    results: readSession({
      tasks,
      workDir,
      sessionStart,
      sessionEnd,
      sessionBudgetMs,
      reserveMs,
    }),
  };
}
