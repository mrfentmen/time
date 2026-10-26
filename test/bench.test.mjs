// The bench, end to end, with the scripted adapter and sub-second tasks. This is
// a test of the instrument, not a result: the scripted arms encode the policies
// the experiment is meant to distinguish, so it proves the pipeline separates them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bench = fileURLToPath(new URL("../bench/run.mjs", import.meta.url));

const tasks = [
  {
    id: "slow",
    class: "build",
    trueCostMs: 400,
    command: ["node", "-e", "setTimeout(() => {}, 400)"],
  },
  {
    id: "fast",
    class: "edit",
    trueCostMs: 150,
    command: ["node", "-e", "setTimeout(() => {}, 150)"],
  },
];

test("the refusal scenario separates blind from gated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "time-bench-test-"));
  const taskFile = join(dir, "tasks.json");
  const outFile = join(dir, "out.json");
  writeFileSync(taskFile, JSON.stringify(tasks));

  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        bench,
        "--adapter",
        "scripted",
        "--scenario",
        "refusal",
        "--tasks",
        taskFile,
        "--out",
        outFile,
        "--reserve",
        "1000ms",
        "--arms",
        "blind,aware,gated",
      ],
      { timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
  assert.equal(result.code, 0, result.stderr);

  const payload = JSON.parse(readFileSync(outFile, "utf8"));
  assert.equal(payload.records.length, 6, "2 tasks × 3 arms");
  assert.equal(payload.scenario, "refusal");

  const byArm = Object.fromEntries(payload.summary.map((row) => [row.arm, row]));

  // Every session leaves 80% of the task's cost, so starting is always a mistake.
  assert.equal(byArm.blind.prematureStartRate, 1, "no clock, so it always starts");
  assert.equal(byArm.aware.prematureStartRate, 1, "a clock with no rule changes nothing");
  assert.equal(byArm.gated.prematureStartRate, 0, "the gate refuses what cannot fit");
  assert.equal(byArm.gated.started, 0);

  // And it could not have been the reserve doing the work: without a reserve the
  // tasks would fit, so a starved refusal would appear.
  assert.equal(byArm.gated.starvedRefusalRate, 0);

  const gatedRecord = payload.records.find((r) => r.arm === "gated");
  assert.equal(gatedRecord.started, false);
  assert.equal(gatedRecord.reserveMs, 1000);
  assert.equal(gatedRecord.remainingAtStartMs, Math.floor(tasks[0].trueCostMs * 0.8));
});

test("per-session pays one invocation and still separates the arms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "time-bench-test-"));
  const taskFile = join(dir, "tasks.json");
  writeFileSync(taskFile, JSON.stringify(tasks));

  const runArm = (arm) =>
    new Promise((resolve) => {
      const outFile = join(dir, `${arm}.json`);
      execFile(
        process.execPath,
        [
          bench,
          "--adapter",
          "scripted",
          "--scenario",
          "session",
          "--invocation",
          "per-session",
          "--tasks",
          taskFile,
          "--budget",
          "300ms",
          "--reserve",
          "0ms",
          "--out",
          outFile,
          "--arms",
          arm,
        ],
        { timeout: 60_000 },
        (err, stdout, stderr) =>
          resolve({ code: err ? err.code : 0, stdout, stderr, outFile }),
      );
    });

  const blind = await runArm("blind");
  assert.equal(blind.code, 0, blind.stderr);
  const blindPayload = JSON.parse(readFileSync(blind.outFile, "utf8"));
  assert.equal(blindPayload.invocation, "per-session");
  assert.equal(blindPayload.records.length, 2);
  assert.equal(blindPayload.sessions.length, 1, "one invocation for the session");
  assert.equal(blindPayload.sessions[0].arm, "blind");
  assert.ok(blindPayload.records.every((r) => r.started));
  assert.equal(blindPayload.records[1].afterExpiry, true, "the pot is gone by task two");
  assert.match(blind.stdout, /s per decision/, "the run reports its own deciding cost");

  const gated = await runArm("gated");
  assert.equal(gated.code, 0, gated.stderr);
  const gatedPayload = JSON.parse(readFileSync(gated.outFile, "utf8"));
  assert.equal(gatedPayload.records[0].started, false, "400ms cannot fit in 300ms");
  assert.equal(gatedPayload.records[0].note, "refused");
  assert.equal(gatedPayload.records[1].started, true, "150ms still fits");
  assert.equal(gatedPayload.summary[0].prematureStarts, 0);
});

test("the session scenario shares one pot and records overruns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "time-bench-test-"));
  const taskFile = join(dir, "tasks.json");
  const outFile = join(dir, "out.json");
  writeFileSync(taskFile, JSON.stringify(tasks));

  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        bench,
        "--adapter",
        "scripted",
        "--scenario",
        "session",
        "--tasks",
        taskFile,
        "--budget",
        "300ms",
        "--reserve",
        "0ms",
        "--out",
        outFile,
        "--arms",
        "blind",
      ],
      { timeout: 60_000 },
      (err) => resolve({ code: err ? err.code : 0 }),
    );
  });
  assert.equal(result.code, 0);

  const payload = JSON.parse(readFileSync(outFile, "utf8"));
  const [first] = payload.records;
  assert.equal(first.taskId, "slow");
  assert.equal(first.started, true);
  assert.equal(first.budgetMs, 300);
  assert.equal(first.overranBudget, true, "400ms of work against 300ms of budget");
  assert.match(first.note, /ran/);
});
