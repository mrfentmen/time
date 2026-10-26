// The ledger commands, driven through the real CLI with a temp ledger file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../time.mjs", import.meta.url));

function ledgerPath() {
  return join(mkdtempSync(join(tmpdir(), "time-ledger-")), "ledger.jsonl");
}

function run(ledger, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, TIME_LEDGER: ledger } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout: stdout.trim(), stderr }),
    );
  });
}

test("plan then done records an item and its actual cost", async () => {
  const ledger = ledgerPath();
  const plan = await run(ledger, ["plan", "auth-review", "--estimate", "8m", "--class", "review"]);
  assert.equal(plan.code, 0);
  assert.match(plan.stdout, /plan: auth-review — estimated 8m 00s \(review\)/);

  const done = await run(ledger, ["done"]);
  assert.equal(done.code, 0);
  assert.match(done.stdout, /done: auth-review — 0m 0\ds \(estimated 8m 00s, 0\.0\dx\)/);

  const events = readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.type),
    ["plan", "done"],
    "append-only, in order",
  );
  assert.equal(events[0].estimateMs, 480_000);
  assert.equal(events[0].class, "review");
  assert.equal(events[1].id, events[0].id, "done closes the plan it came from");
});

test("report turns completed items into a calibration row", async () => {
  const ledger = ledgerPath();
  await run(ledger, ["plan", "migration", "--estimate", "5m", "--class", "migration"]);
  await run(ledger, ["done"]);
  const report = await run(ledger, ["report", "--json"]);
  assert.equal(report.code, 0);
  const rows = JSON.parse(report.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].class, "migration");
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].estimateP50, 300_000);
  assert.ok(Number.isFinite(rows[0].actualP50));
});

test("report on an empty ledger says so instead of failing", async () => {
  const empty = await run(ledgerPath(), ["report"]);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /no completed items yet/);
  const json = await run(ledgerPath(), ["report", "--json"]);
  assert.equal(json.stdout, "[]");
});

test("a second plan without done is refused, so items cannot be silently lost", async () => {
  const ledger = ledgerPath();
  await run(ledger, ["plan", "first", "--estimate", "2m"]);
  const second = await run(ledger, ["plan", "second", "--estimate", "3m"]);
  assert.equal(second.code, 64);
  assert.match(second.stderr, /a plan is already open: first/);
});

test("done with nothing open is a usage error", async () => {
  const { code, stderr } = await run(ledgerPath(), ["done"]);
  assert.equal(code, 64);
  assert.match(stderr, /no open plan/);
});

test("plan requires an estimate and a label", async () => {
  const noEstimate = await run(ledgerPath(), ["plan", "vague"]);
  assert.equal(noEstimate.code, 64);
  assert.match(noEstimate.stderr, /--estimate is required/);

  const noLabel = await run(ledgerPath(), ["plan", "--estimate", "5m"]);
  assert.equal(noLabel.code, 64);
  assert.match(noLabel.stderr, /plan needs a label/);

  const badDuration = await run(ledgerPath(), ["plan", "x", "--estimate", "soon"]);
  assert.equal(badDuration.code, 64);
});

test("done rejects a status it does not understand", async () => {
  const ledger = ledgerPath();
  await run(ledger, ["plan", "x", "--estimate", "1m"]);
  const { code, stderr } = await run(ledger, ["done", "--status", "maybe"]);
  assert.equal(code, 64);
  assert.match(stderr, /--status must be ok or failed/);
});
