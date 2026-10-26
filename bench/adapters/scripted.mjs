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

function askGate(tool, args, statePath) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tool, ...args],
      { env: { ...process.env, TIMER_STATE: statePath } },
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
