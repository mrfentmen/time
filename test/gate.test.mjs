// Tests for the start gate. Each test builds its own state file with an
// explicit start time, so nothing depends on how long the test suite ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../time.mjs", import.meta.url));
const MIN = 60_000;

// A state file whose budget started `elapsedMs` ago. Pass null for no file.
function sandbox(elapsedMs, minutes = 30) {
  const dir = mkdtempSync(join(tmpdir(), "time-gate-"));
  const statePath = join(dir, "state.json");
  if (elapsedMs !== null) {
    writeFileSync(statePath, JSON.stringify({ start: Date.now() - elapsedMs, minutes }));
  }
  return statePath;
}

function run(statePath, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, TIMER_STATE: statePath } },
      (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout: stdout.trim(), stderr });
      },
    );
  });
}

test("start writes a state file and exits 0", async () => {
  const statePath = sandbox(null);
  const { code, stdout } = await run(statePath, ["start"]);
  assert.equal(code, 0);
  assert.match(stdout, /timer started: 30 minutes/);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.minutes, 30);
  assert.ok(Math.abs(Date.now() - state.start) < 5000);
});

test("MINUTES sets the budget and is validated", async () => {
  const statePath = sandbox(null);
  const ok = await run(statePath, ["start"]);
  assert.equal(ok.code, 0);

  const bad = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "start"],
      { env: { ...process.env, TIMER_STATE: sandbox(null), MINUTES: "soon" } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }),
    );
  });
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /MINUTES must be a positive number/);
});

test("check keeps its old output and exit code on a live budget", async () => {
  const { code, stdout } = await run(sandbox(1 * MIN), ["check"]);
  assert.equal(code, 0);
  assert.match(stdout, /^elapsed 1m \d\ds \| remaining 2[89]m \d\ds \| running$/);
});

test("check exits 2 once the budget is spent", async () => {
  const { code, stdout } = await run(sandbox(31 * MIN), ["check"]);
  assert.equal(code, 2);
  assert.match(stdout, /EXPIRED — stop work/);
});

test("--needs fits when the task and its reserve both fit", async () => {
  // 20 minutes into a 30 minute budget: ~10m left, 6m task + 3m reserve = 9m.
  const { code, stdout } = await run(sandbox(20 * MIN), ["check", "--needs", "6m"]);
  assert.equal(code, 0);
  assert.match(stdout, /needs 6m 00s \+ 3m 00s reserve = 9m 00s \| fits, \d+m \d\ds spare/);
});

test("the verification reserve is what tips a decision", async () => {
  // Same ~10m left, an 8m task: 8m fits alone, 8m + 3m does not.
  const statePath = sandbox(20 * MIN);
  const withReserve = await run(statePath, ["check", "--needs", "8m"]);
  assert.equal(withReserve.code, 2);
  assert.match(withReserve.stdout, /DOES NOT FIT — \d+m \d\ds short/);

  const noReserve = await run(statePath, ["check", "--needs", "8m", "--reserve", "0"]);
  assert.equal(noReserve.code, 0);
  assert.match(noReserve.stdout, /needs 8m 00s \+ 0m 00s reserve = 8m 00s \| fits/);
});

test("a shortfall of one second does not read as zero", async () => {
  // 25 minutes into a 30 minute budget: 5m left, and 2m + 3m needs 5m.
  const { code, stdout } = await run(sandbox(25 * MIN), ["check", "--needs", "2m"]);
  assert.equal(code, 2);
  assert.match(stdout, /DOES NOT FIT — 0m 0\ds short/);
  assert.doesNotMatch(stdout, /0m 00s short/);
});

test("expiry wins even over a zero-length request", async () => {
  const { code, stdout } = await run(sandbox(31 * MIN), [
    "check",
    "--needs",
    "0",
    "--reserve",
    "0",
  ]);
  assert.equal(code, 2);
  assert.match(stdout, /EXPIRED — stop work/);
});

test("durations parse as bare minutes, seconds, and hours", async () => {
  // ~10m left. Bare 6 == 6m, and 90s is under a minute and a half.
  const statePath = sandbox(20 * MIN);
  assert.equal((await run(statePath, ["check", "--needs", "6"])).code, 0);
  assert.equal((await run(statePath, ["check", "--needs", "90s"])).code, 0);
  assert.equal((await run(statePath, ["check", "--needs=6m"])).code, 0);
  // 0h1m30s is 90s, still fine; 1h30m is not.
  assert.equal((await run(statePath, ["check", "--needs", "0h1m30s"])).code, 0);
  assert.equal((await run(statePath, ["check", "--needs", "1h30m"])).code, 2);
});

test("a malformed duration is a usage error, not a verdict", async () => {
  for (const arg of ["8x", "", "m", "--"]) {
    const { code, stdout, stderr } = await run(sandbox(20 * MIN), ["check", "--needs", arg]);
    assert.equal(code, 64, `--needs ${JSON.stringify(arg)} should be a usage error`);
    assert.equal(stdout, "");
    assert.match(stderr, /needs a duration|durations:/);
  }
});

test("an unknown flag is a usage error", async () => {
  const { code, stderr } = await run(sandbox(20 * MIN), ["check", "--needsd", "8m"]);
  assert.equal(code, 64);
  assert.match(stderr, /unknown flag: --needsd/);
});

test("check with no timer running says so instead of crashing", async () => {
  const { code, stdout, stderr } = await run(sandbox(null), ["check"]);
  assert.equal(code, 64);
  assert.equal(stdout, "");
  assert.match(stderr, /no timer running at .*state\.json/);
  assert.match(stderr, /time\.mjs start/);
});

test("a corrupt state file is a usage error", async () => {
  const statePath = sandbox(null);
  writeFileSync(statePath, "{ not json");
  const { code, stderr } = await run(statePath, ["check"]);
  assert.equal(code, 64);
  assert.match(stderr, /not valid JSON/);
});
