// The one-invocation-per-session adapter reads its ground truth from the markers
// each task's work script writes, so the reconstruction of "when did this start"
// is the part that has to be exact. These tests build marker files by hand and
// check the arithmetic, including the case the supervisor cannot observe: a task
// that was never started leaves no file, so the moment of its refusal is bounded
// from the next start rather than guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredCost, prompt, readSession } from "../bench/adapters/session.mjs";

const task = (id) => ({ id, class: "build", trueCostMs: 1000, command: ["node", "work.mjs"] });

function markers(workDir, id, startedAt, finishedAt) {
  const dir = join(workDir, "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".started"), String(startedAt));
  if (finishedAt !== null) writeFileSync(join(dir, ".done"), String(finishedAt));
}

test("the gated prompt spells out each task's own cost, not a placeholder", () => {
  // A literal `<cost in ms>` once survived into a live run and the agent ran it,
  // got exit 64 and refused the entire session. The command has to be copyable.
  const tasks = [{ ...task("a"), trueCostMs: 1000 }, { ...task("b"), trueCostMs: 2500 }];
  const text = prompt({ tasks, arm: "gated", tool: "/x/time.mjs", reserveMs: 500, workDir: "/w" });
  assert.match(text, /a: node \/x\/time\.mjs check --needs 1000ms --reserve 500ms/);
  assert.match(text, /b: node \/x\/time\.mjs check --needs 2500ms --reserve 500ms/);
  assert.doesNotMatch(text, /<cost/);
});

test("a scaled estimate changes what is told, never what is measured", () => {
  assert.equal(declaredCost({ trueCostMs: 1000 }, 2.6), 2600);
  assert.equal(declaredCost({ trueCostMs: 1000 }, 1), 1000);
});

test("the calibrated arm asks for the class's measured cost, not the estimate", () => {
  const tasks = [{ ...task("a"), class: "review", trueCostMs: 1000 }];
  const text = prompt({ tasks, arm: "gated-cal", tool: "/x/time.mjs", reserveMs: 500, workDir: "/w" });
  assert.match(text, /a: node \/x\/time\.mjs check --for review --reserve 500ms/);
  assert.doesNotMatch(text, /check --needs/, "the estimate is exactly what this arm distrusts");
});

test("markers give start time, cost and what was left when the work began", () => {
  const workDir = mkdtempSync(join(tmpdir(), "time-session-"));
  const sessionStart = 1_000_000;
  markers(workDir, "a", sessionStart + 200, sessionStart + 900);
  const [a] = readSession({
    tasks: [task("a")],
    workDir,
    sessionStart,
    sessionEnd: sessionStart + 2_000,
    sessionBudgetMs: 1_000,
    reserveMs: 100,
  });
  assert.equal(a.started, true);
  assert.equal(a.finished, true);
  assert.equal(a.runtimeMs, 700);
  assert.equal(a.remainingAtStartMs, 800, "1000ms budget, 200ms already spent");
});

test("a started task with no .done was cut off, and is charged to the end of the session", () => {
  const workDir = mkdtempSync(join(tmpdir(), "time-session-"));
  const sessionStart = 1_000_000;
  markers(workDir, "a", sessionStart + 100, null);
  const [a] = readSession({
    tasks: [task("a")],
    workDir,
    sessionStart,
    sessionEnd: sessionStart + 1_500,
    sessionBudgetMs: 1_000,
    reserveMs: 0,
  });
  assert.equal(a.started, true);
  assert.equal(a.finished, false);
  assert.equal(a.runtimeMs, 1_400);
  assert.equal(a.remainingAtStartMs, 900);
});

test("a skipped task is bounded by the next start, never by the time it would have liked", () => {
  const workDir = mkdtempSync(join(tmpdir(), "time-session-"));
  const sessionStart = 1_000_000;
  markers(workDir, "a", sessionStart + 100, sessionStart + 400);
  markers(workDir, "c", sessionStart + 700, sessionStart + 900);
  const results = readSession({
    tasks: [task("a"), task("b"), task("c")],
    workDir,
    sessionStart,
    sessionEnd: sessionStart + 1_200,
    sessionBudgetMs: 1_000,
    reserveMs: 0,
  });
  const b = results[1];
  assert.equal(b.started, false);
  assert.equal(b.runtimeMs, 0);
  // b was refused somewhere in (400, 700]; 700 is the later bound, which is the
  // one that cannot flatter the gate: it claims the least remaining time.
  assert.equal(b.remainingAtStartMs, 300);

  const trailing = readSession({
    tasks: [task("a"), task("b")],
    workDir,
    sessionStart,
    sessionEnd: sessionStart + 1_200,
    sessionBudgetMs: 1_000,
    reserveMs: 0,
  })[1];
  assert.equal(trailing.remainingAtStartMs, -200, "a trailing skip is bounded by the session end");
});

test("an unreadable marker still counts as started", () => {
  const workDir = mkdtempSync(join(tmpdir(), "time-session-"));
  const dir = join(workDir, "tasks", "a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".started"), "");
  const [a] = readSession({
    tasks: [task("a")],
    workDir,
    sessionStart: Date.now(),
    sessionEnd: Date.now(),
    sessionBudgetMs: 1_000,
    reserveMs: 0,
  });
  assert.equal(a.started, true, "the file exists, so the work began");
});
