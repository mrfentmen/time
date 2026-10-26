// A deterministic stand-in for an agent, so the harness and the metrics can be
// exercised without spending tokens on a model. It is not a result: it encodes
// the policies the experiment is trying to distinguish, which makes it useful
// only for proving the pipeline and for CI.
//
//   blind  starts whatever it is given. It has no clock.
//   aware  asks for the remaining time, then starts as long as any is left.
//          This is the "a clock is not a decision" hypothesis, made executable.
//   gated  asks the gate, and only starts what fits.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(command[0], command.slice(1), { cwd, stdio: "ignore" });
    child.on("close", (code) => {
      const runtimeMs = Number((process.hrtime.bigint() - started) / 1000000n);
      resolve({ code, runtimeMs });
    });
  });
}

function askGate(tool, args, statePath, ledgerPath = null) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tool, ...args],
      {
        env: {
          ...process.env,
          TIMER_STATE: statePath,
          ...(ledgerPath ? { TIME_LEDGER: ledgerPath } : {}),
        },
      },
      (error) => resolve(error ? error.code : 0),
    );
  });
}

export async function run({ task, arm, tool, statePath, workDir, reserveMs }) {
  if (arm !== "blind") {
    const args =
      arm === "gated"
        ? ["check", "--needs", `${task.trueCostMs}ms`, "--reserve", `${reserveMs}ms`]
        : ["check"];
    const code = await askGate(tool, args, statePath);
    // 2 is the gate's "do not start". Anything else (including 64) is treated as
    // a go, so a broken gate cannot quietly flatter the results.
    if (code === 2) return { started: false, finished: false, runtimeMs: 0, note: "refused" };
  }
  const { code, runtimeMs } = await runCommand(task.command, workDir);
  return {
    started: true,
    finished: code === 0,
    runtimeMs,
    note: code === 0 ? "ran" : `command exited ${code}`,
  };
}

// The same three policies, one pass over the task list inside a single
// invocation, so `--invocation per-session` can be tested without a model.
export async function runSession({
  tasks,
  arm,
  tool,
  statePath,
  workDir,
  reserveMs,
  sessionStart,
  sessionBudgetMs,
  ledgerPath = null,
}) {
  const results = [];
  for (const task of tasks) {
    const dir = join(workDir, "tasks", task.id);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(task.files ?? {})) {
      writeFileSync(join(dir, name), content);
    }
    const decidedAt = Date.now();
    const remaining = sessionStart + sessionBudgetMs - decidedAt;
    if (arm !== "blind") {
      const args =
        arm === "gated"
          ? ["check", "--needs", `${task.trueCostMs}ms`, "--reserve", `${reserveMs}ms`]
          : arm === "gated-cal"
            ? ["check", "--for", task.class ?? "untagged", "--reserve", `${reserveMs}ms`]
            : ["check"];
      if ((await askGate(tool, args, statePath, ledgerPath)) === 2) {
        results.push({
          taskId: task.id,
          started: false,
          finished: false,
          runtimeMs: 0,
          remainingAtStartMs: remaining,
          note: "refused",
        });
        continue;
      }
    }
    const { code, runtimeMs } = await runCommand(task.command, dir);
    results.push({
      taskId: task.id,
      started: true,
      finished: code === 0,
      runtimeMs,
      remainingAtStartMs: remaining,
      note: code === 0 ? "ran" : `command exited ${code}`,
    });
  }
  return { results, agentOutput: `scripted ${arm} session`, agentStderrTail: "" };
}
