// The same two experiments, driven by `opencode run` instead of `codex exec`.
//
// This exists for E4: the effect has to survive a second harness, or it is a fact
// about one CLI. opencode takes the prompt as an argument rather than on stdin and
// approves shell permissions with --auto, so the adapter differs; everything that
// matters — the prompt ladder, the marker files, the supervisor's clock — is shared
// with the codex adapters on purpose.
//
// Note the confound in the result: opencode here runs a different model as well as a
// different harness, so a difference between the two runs cannot be attributed to
// either one alone.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { prompt as taskPrompt } from "./cli.mjs";
import { materialise, prompt as sessionPrompt, readSession } from "./session.mjs";

export const defaultModel = "opencode/glm-5.3-flash-free";

export function buildArgs({ prompt, model }) {
  return ["run", "--auto", "--model", model, prompt];
}

function ask({ prompt, model, cwd, capMs, env }) {
  const child = spawn("opencode", buildArgs({ prompt, model }), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
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

  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        killed,
        runtimeMs: Number((process.hrtime.bigint() - startedAt) / 1000000n),
        out,
        err,
      });
    });
  });
}

export async function run({ task, arm, tool, reserveMs, workDir, capMs, statePath, model }) {
  const text = taskPrompt({ task, arm, tool, reserveMs, workDir });
  const env = { ...process.env, TIMER_STATE: statePath };
  const { code, killed, runtimeMs, out, err } = await ask({
    prompt: text,
    model,
    cwd: workDir,
    capMs,
    env,
  });
  const started = existsSync(join(workDir, ".started"));
  const finished = existsSync(join(workDir, ".done"));
  return {
    started,
    finished,
    runtimeMs,
    note: killed ? "killed at cap" : `agent exited ${code}`,
    agentExit: code,
    agentOutput: out.trim().slice(-500),
    agentStderrTail: err.trim().slice(-300),
  };
}

export async function runSession({
  tasks,
  arm,
  tool,
  reserveMs,
  workDir,
  capMs,
  statePath,
  sessionStart,
  sessionBudgetMs,
  estimateScale = 1,
  ledgerPath = null,
  model,
}) {
  materialise(tasks, workDir);
  const text = sessionPrompt({ tasks, arm, tool, reserveMs, workDir, estimateScale });
  const env = {
    ...process.env,
    TIMER_STATE: statePath,
    ...(ledgerPath ? { TIME_LEDGER: ledgerPath } : {}),
  };
  const { code, killed, out, err } = await ask({ prompt: text, model, cwd: workDir, capMs, env });
  const sessionEnd = Date.now();
  return {
    code,
    killed,
    sessionEnd,
    agentOutput: out.trim().slice(-1200),
    agentStderrTail: err.trim().slice(-300),
    results: readSession({ tasks, workDir, sessionStart, sessionEnd, sessionBudgetMs, reserveMs }),
  };
}
