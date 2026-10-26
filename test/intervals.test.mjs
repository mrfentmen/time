// The interval, and the choice of what to resample. A binomial interval over records
// would be far narrower than the data deserves: records from one session move
// together, so the session is the unit that gets resampled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapRate, rateWithInterval } from "../lib/intervals.mjs";

const record = (premature) => ({ prematureStart: premature });

test("the interval is deterministic for a seed", () => {
  const sessions = [[record(true), record(false)], [record(false), record(false)], [record(true), record(true)]];
  const a = bootstrapRate(sessions, { seed: 7 });
  const b = bootstrapRate(sessions, { seed: 7 });
  assert.deepEqual(a, b, "the same records must print the same interval");
  assert.ok(a.low >= 0 && a.high <= 1);
  assert.ok(a.low <= a.high);
});

test("all sessions agreeing gives a degenerate interval, not a confident one", () => {
  const sessions = Array.from({ length: 6 }, () => [record(true), record(true)]);
  const stats = rateWithInterval(sessions);
  assert.equal(stats.rate, 1);
  assert.equal(stats.interval.low, 1);
  assert.equal(stats.interval.high, 1);
  assert.equal(stats.sessions, 6);
});

test("the interval brackets the pooled rate and reflects session spread", () => {
  const sessions = [
    [record(true), record(true)],
    [record(false), record(false)],
    [record(false), record(false)],
    [record(false), record(true)],
  ];
  const stats = rateWithInterval(sessions);
  assert.equal(stats.decisions, 8);
  assert.equal(stats.premature, 3);
  assert.equal(stats.rate, 3 / 8);
  assert.ok(stats.interval.low <= stats.rate && stats.rate <= stats.interval.high);
  // Resampling four sessions cannot pin the rate to the pooled value.
  assert.ok(stats.interval.high - stats.interval.low > 0.2);
});

test("no sessions is not a rate of zero", () => {
  assert.deepEqual(bootstrapRate([]), { low: null, high: null });
});
