#!/usr/bin/env node
// Wall-clock budget for a work session.
//
//   start                 begin a budget (MINUTES, default 30)
//   check                 elapsed and remaining; exit 2 once it is spent
//   check --needs 8m      exit 0 only if 8m of work *and* a reserve for
//                         verifying it still fit in what is left
//
// Exit codes: 0 go ahead, 2 do not start, 64 bad usage or no timer running.
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.TIMER_STATE ?? "/tmp/time-timer.json";
const budgetMinutes = Number(process.env.MINUTES ?? 30);
// Verification is work too: a change you cannot typecheck, test and deploy
// before the bell is a change that leaves the tree mid-surgery. Three minutes
// is roughly the cheap end of that on a small repo.
const defaultReserveMs = 3 * 60_000;

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// A shortfall is rounded up, so one second short never prints as "0m 00s short".
const fmtShort = (ms) => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function usage(message) {
  console.error(message);
  console.error(
    "usage: time.mjs start | time.mjs check [--needs <dur>] [--reserve <dur>]\n" +
      "       durations: 90s, 8m, 1h30m, or a bare number of minutes",
  );
  process.exit(64);
}

// Returns milliseconds, or null when `raw` is not a duration. A bare number is
// minutes, matching MINUTES.
function parseDuration(raw) {
  if (raw == null || raw === "") return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60_000);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !m.slice(1).some((part) => part !== undefined)) return null;
  const [, h, min, s] = m;
  return (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
}

function parseFlags(argv) {
  const flags = { needs: null, reserve: defaultReserveMs };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name !== "--needs" && name !== "--reserve") usage(`unknown flag: ${arg}`);
    const raw = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    const ms = parseDuration(raw);
    if (ms === null) {
      usage(
        `${name} needs a duration like 8m, 90s or 1h30m (got ${raw === undefined ? "nothing" : JSON.stringify(raw)})`,
      );
    }
    if (name === "--needs") flags.needs = ms;
    else flags.reserve = ms;
  }
  return flags;
}

function loadState() {
  let raw;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    usage(`no timer running at ${statePath}\nstart one with: time.mjs start`);
  }
  try {
    const state = JSON.parse(raw);
    if (!Number.isFinite(state.start) || !Number.isFinite(state.minutes)) {
      usage(`timer state at ${statePath} is malformed`);
    }
    return state;
  } catch {
    usage(`timer state at ${statePath} is not valid JSON`);
  }
}

const [cmd = "check", ...rest] = process.argv.slice(2);

if (cmd === "start") {
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
    usage(`MINUTES must be a positive number of minutes (got ${process.env.MINUTES})`);
  }
  writeFileSync(statePath, JSON.stringify({ start: Date.now(), minutes: budgetMinutes }));
  console.log(`timer started: ${budgetMinutes} minutes`);
  process.exit(0);
}
if (cmd !== "check") usage(`unknown command: ${cmd}`);

const { needs, reserve } = parseFlags(rest);
const state = loadState();
const elapsed = Date.now() - state.start;
const remaining = state.start + state.minutes * 60_000 - Date.now();
const clock = `elapsed ${fmt(elapsed)} | remaining ${fmt(remaining)}`;

if (needs === null) {
  console.log(`${clock} | ${remaining <= 0 ? "EXPIRED — stop work" : "running"}`);
  process.exit(remaining <= 0 ? 2 : 0);
}

const needed = needs + reserve;
const spare = remaining - needed;
const fits = remaining > 0 && spare >= 0;
const verdict =
  remaining <= 0
    ? "EXPIRED — stop work"
    : fits
      ? `fits, ${fmt(spare)} spare`
      : `DOES NOT FIT — ${fmtShort(-spare)} short`;
console.log(
  `${clock} | needs ${fmt(needs)} + ${fmt(reserve)} reserve = ${fmt(needed)} | ${verdict}`,
);
process.exit(fits ? 0 : 2);
