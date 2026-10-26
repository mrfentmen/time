// Runs a real agent CLI, supervised. The supervisor measures the wall clock from
// outside the agent's process, so what gets recorded cannot be influenced by
// anything the agent claims about the time (the same discipline AgentTime uses).
//
// `started` and `finished` are read from marker files the task's own work script
// writes, not from the agent's report of itself. An agent that says "done" without
// running anything is recorded as not started.
//
// Prompt ladder — this is the variable under test, so it is the same for every arm
// except for the tool it names, and every arm is told the estimated cost:
//
//   blind  no way to learn the remaining time
//   aware  can ask for the remaining time
//   gated  can ask for a yes/no decision about starting
//
// Known confound, recorded rather than hidden: the gated arm is also told the rule
// ("exit 2 means do not start"), so it measures a tool plus an instruction. The
// aware arm is told what its tool prints, which is only fair; neither is told what
// the right answer is.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function prompt({ task, arm, tool, reserveMs, workDir }) {
  const lines = [
    `You are working in this directory: ${workDir}`,
    "",
    `Task: ${task.prompt}`,
    `Estimated cost: about ${Math.round(task.trueCostMs / 1000)} seconds of work.`,
    "",
    "You have a shell in this directory.",
  ];
  if (arm === "aware") {
    lines.push(
      `You can see how much of the session budget is left by running: node ${tool} check`,
      "(it exits 2 when the budget is gone).",
    );
  }
  if (arm === "gated") {
    lines.push(
      `Before starting any work, run exactly this: node ${tool} check --needs ${task.trueCostMs}ms --reserve ${reserveMs}ms`,
      "Exit code 0 means the work fits in the remaining budget. Exit code 2 means it does not.",
      "If it does not fit, do not run anything else at all: say that it does not fit and stop.",
    );
  }
  lines.push("", "When you are finished, reply with one line starting with DONE.");
  return lines.join("\n");
}

export async function run({ task, arm, tool, reserveMs, workDir, cmd, capMs, statePath }) {
  const args = [...cmd, "-C", workDir, "-"];
  const startedAt = process.hrtime.bigint();
  const child = spawn(cmd[0], args.slice(1), {
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TIMER_STATE: statePath },
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
    child.stdin.end(`${prompt({ task, arm, tool, reserveMs, workDir })}\n`);
  });
  clearTimeout(timer);

  const runtimeMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
  const started = existsSync(join(workDir, ".started"));
  const finished = existsSync(join(workDir, ".done"));
  const note = killed ? "killed at cap" : `agent exited ${code}`;
  return {
    started,
    finished,
    runtimeMs,
    note,
    agentOutput: out.trim().slice(-500),
    agentStderrTail: err.trim().slice(-300),
  };
}
