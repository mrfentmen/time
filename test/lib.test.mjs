// Unit tests for the pure modules. No clock, no files, no shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatShortfall,
  parseDuration,
} from "../lib/duration.mjs";
import { decide, GateError } from "../lib/gate.mjs";
import { classify, summarize } from "../lib/metrics.mjs";
import { calibration } from "../lib/ledger.mjs";

test("durations parse in every documented form", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("8m"), 480_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("0h1m30s"), 90_000);
  assert.equal(parseDuration("1500ms"), 1500);
  assert.equal(parseDuration("8"), 480_000, "a bare number is minutes");
  assert.equal(parseDuration("0"), 0);
});

test("durations that are not durations are null, not zero", () => {
  for (const raw of ["8x", "", "m", "1.5h", "8 m", "-5m", "8m30", null, undefined]) {
    assert.equal(parseDuration(raw), null, `${JSON.stringify(raw)} should not parse`);
  }
});

test("formatting floors what is left and rounds up what is short", () => {
  assert.equal(formatDuration(0), "0m 00s");
  assert.equal(formatDuration(59_999), "0m 59s");
  assert.equal(formatDuration(-5_000), "0m 00s", "never prints a negative");
  assert.equal(formatShortfall(1), "0m 01s", "one second short is not zero");
  assert.equal(formatShortfall(60_000), "1m 00s");
});

test("the gate approves only what fits with its reserve", () => {
  const fits = decide({ remainingMs: 720_000, needsMs: 480_000, reserveMs: 180_000 });
  assert.equal(fits.ok, true);
  assert.equal(fits.expired, false);
  assert.equal(fits.spareMs, 60_000);

  const doesNotFit = decide({ remainingMs: 600_000, needsMs: 480_000, reserveMs: 300_000 });
  assert.equal(doesNotFit.ok, false);
  assert.equal(doesNotFit.shortByMs, 180_000);
});

test("the reserve is the deciding term", () => {
  const withReserve = decide({ remainingMs: 480_000, needsMs: 480_000, reserveMs: 180_000 });
  const withoutReserve = decide({ remainingMs: 480_000, needsMs: 480_000, reserveMs: 0 });
  assert.equal(withReserve.ok, false);
  assert.equal(withoutReserve.ok, true);
});

test("an expired budget approves nothing, not even zero work", () => {
  const decision = decide({ remainingMs: 0, needsMs: 0, reserveMs: 0 });
  assert.equal(decision.expired, true);
  assert.equal(decision.ok, false);
});

test("the gate rejects nonsense instead of guessing", () => {
  for (const bad of [
    { remainingMs: Number.NaN, needsMs: 0, reserveMs: 0 },
    { remainingMs: 1000, needsMs: -1, reserveMs: 0 },
    { remainingMs: 1000, needsMs: 0, reserveMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => decide(bad), GateError);
  }
});

test("classification tells a premature start from a starved refusal", () => {
  const base = { reserveMs: 1000, remainingAtStartMs: 5000 };
  assert.equal(classify({ ...base, started: true, trueCostMs: 6000 }).prematureStart, true);
  assert.equal(classify({ ...base, started: true, trueCostMs: 6000 }).starvedRefusal, false);
  assert.equal(classify({ ...base, started: false, trueCostMs: 4000 }).starvedRefusal, true);
  // Fits alone but not with its reserve: refusing is correct, not starving.
  assert.equal(classify({ ...base, started: false, trueCostMs: 4500 }).starvedRefusal, false);
  assert.equal(classify({ ...base, started: true, trueCostMs: 4500 }).prematureStart, true);
});

test("summaries count sessions, not records, for utilisation", () => {
  const rows = summarize([
    {
      arm: "gated",
      taskId: "a",
      sessionId: "s1",
      budgetMs: 10_000,
      remainingAtStartMs: 10_000,
      trueCostMs: 4_000,
      reserveMs: 0,
      started: true,
      finished: true,
      runtimeMs: 4_000,
    },
    {
      arm: "gated",
      taskId: "b",
      sessionId: "s1",
      budgetMs: 10_000,
      remainingAtStartMs: 6_000,
      trueCostMs: 5_000,
      reserveMs: 0,
      started: false,
      finished: false,
      runtimeMs: 0,
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prematureStarts, 0);
  assert.equal(rows[0].starvedRefusals, 1);
  assert.equal(rows[0].utilisation, 0.4, "4s used of one 10s session");
});

test("calibration reports the bias factor that corrects an estimate", () => {
  const rows = calibration([
    { class: "build", estimateMs: 1000, actualMs: 2000 },
    { class: "build", estimateMs: 1000, actualMs: 1414 },
    { class: "test", estimateMs: 2000, actualMs: 1000 },
  ]);
  const build = rows.find((r) => r.class === "build");
  assert.equal(build.n, 2);
  assert.equal(build.actualP50, 1707);
  assert.equal(Math.round(build.bias * 100) / 100, 1.68, "geometric mean of 2 and 1.414");
  const tests = rows.find((r) => r.class === "test");
  assert.equal(tests.bias, 0.5, "everything took half as long as estimated");
});

test("calibration survives an item with no usable estimate", () => {
  const rows = calibration([{ class: "docs", estimateMs: 0, actualMs: 500 }]);
  assert.equal(rows[0].bias, null);
  assert.equal(rows[0].actualP50, 500);
});
