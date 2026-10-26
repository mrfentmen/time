#!/usr/bin/env node
// Wall-clock budget for a work session.
//
//   start                 begin a budget (MINUTES, default 30)
//   check                 elapsed and remaining; exit 2 once it is spent
//   check --needs 8m      exit 0 only if 8m of work *and* a reserve for
//                         verifying it still fit in what is left
//   plan <label> --estimate 8m [--class build]
//                         record an intention to do something that big
//   done [--status ok|failed]
//                         close it, recording what it actually cost
//   report                per-class estimate-vs-actual, and the bias factor
//
// Exit codes: 0 go ahead, 2 do not start, 64 bad usage or no timer running.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  formatDuration as fmt,
  formatShortfall as fmtShort,
  parseDuration,
} from "./lib/duration.mjs";
import { decide, GateError } from "./lib/gate.mjs";
import {
  appendEvent,
  calibration,
  completedItems,
  openPlan,
  readEvents,
} from "./lib/ledger.mjs";

const statePath = process.env.TIMER_STATE ?? "/tmp/time-timer.json";
const ledgerPath = process.env.TIME_LEDGER ?? ".time/ledger.jsonl";
const budgetMinutes = Number(process.env.MINUTES ?? 30);
// Verification is work too: a change you cannot typecheck, test and deploy
// before the bell is a change that leaves the tree mid-surgery. Three minutes
// is roughly the cheap end of that on a small repo.
const defaultReserveMs = 3 * 60_000;

function usage(message) {
  console.error(message);
  console.error(
    "usage: time.mjs start | check [--needs <dur>] [--reserve <dur>]\n" +
      "       time.mjs plan <label> --estimate <dur> [--class <name>]\n" +
      "       time.mjs done [--status ok|failed] | time.mjs report [--json]\n" +
      "       durations: 90s, 8m, 1h30m, or a bare number of minutes",
  );
  process.exit(64);
}

// Parses `--flag value` and `--flag=value`, returning a map of flag to raw value.
function parseFlags(argv, allowed) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!allowed.includes(name)) usage(`unknown flag: ${arg}`);
    flags[name] = eq === -1 ? argv[++i] : arg.slice(eq + 1);
  }
  return flags;
}

function durationFlag(flags, name, fallback) {
  if (flags[name] === undefined) {
    if (fallback === undefined) usage(`${name} is required`);
    return fallback;
  }
  const ms = parseDuration(flags[name]);
  if (ms === null) {
    usage(
      `${name} needs a duration like 8m, 90s or 1h30m (got ${JSON.stringify(flags[name])})`,
    );
  }
  return ms;
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

if (cmd === "plan") {
  const [label, ...flagArgs] = rest;
  if (!label || label.startsWith("--")) usage("plan needs a label, e.g. `plan auth-review`");
  const flags = parseFlags(flagArgs, ["--estimate", "--class"]);
  const estimateMs = durationFlag(flags, "--estimate");
  const events = readEvents(ledgerPath);
  const stillOpen = openPlan(events)[0];
  if (stillOpen) {
    usage(
      `a plan is already open: ${stillOpen.label} (close it with \`done\`, or set TIME_LEDGER to a different file)`,
    );
  }
  const event = {
    type: "plan",
    id: randomUUID(),
    label,
    class: flags["--class"] ?? "untagged",
    estimateMs,
    at: Date.now(),
  };
  appendEvent(ledgerPath, event);
  console.log(`plan: ${label} — estimated ${fmt(estimateMs)} (${event.class})`);
  process.exit(0);
}

if (cmd === "done") {
  const flags = parseFlags(rest, ["--status"]);
  const status = flags["--status"] ?? "ok";
  if (!["ok", "failed"].includes(status)) usage(`--status must be ok or failed (got ${status})`);
  const events = readEvents(ledgerPath);
  const stillOpen = openPlan(events)[0];
  if (!stillOpen) {
    usage(`no open plan to close in ${ledgerPath}\nstart one with: time.mjs plan <label> --estimate <dur>`);
  }
  const actualMs = Date.now() - stillOpen.at;
  appendEvent(ledgerPath, { type: "done", id: stillOpen.id, at: Date.now(), actualMs, status });
  const estimate = stillOpen.estimateMs ? ` (estimated ${fmt(stillOpen.estimateMs)}, ${(actualMs / stillOpen.estimateMs).toFixed(2)}x)` : "";
  console.log(`done: ${stillOpen.label} — ${fmt(actualMs)}${estimate}${status === "ok" ? "" : ` [${status}]`}`);
  process.exit(0);
}

if (cmd === "report") {
  const flags = parseFlags(rest, ["--json"]);
  const rows = calibration(completedItems(readEvents(ledgerPath)));
  if (rows.length === 0) {
    if ("--json" in flags) console.log("[]");
    else console.log("no completed items yet — start one with: time.mjs plan <label> --estimate 8m");
    process.exit(0);
  }
  if ("--json" in flags) {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  }
  const show = (ms) => (Number.isFinite(ms) ? fmt(ms) : "—");
  const table = [
    ["class", "n", "est p50", "act p50", "act p90", "bias"],
    ...rows.map((row) => [
      row.class,
      String(row.n),
      show(row.estimateP50),
      show(row.actualP50),
      show(row.actualP90),
      row.bias === null ? "—" : `${row.bias.toFixed(2)}x`,
    ]),
  ];
  const widths = table[0].map((_, column) =>
    Math.max(...table.map((line) => line[column].length)),
  );
  for (const [index, line] of table.entries()) {
    console.log(line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
    if (index === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
  }
  process.exit(0);
}

if (cmd !== "check") usage(`unknown command: ${cmd}`);

const flags = parseFlags(rest, ["--needs", "--reserve"]);
const needs = flags["--needs"] === undefined ? null : durationFlag(flags, "--needs");
const reserve = durationFlag(flags, "--reserve", defaultReserveMs);
const state = loadState();
const elapsed = Date.now() - state.start;
const remaining = state.start + state.minutes * 60_000 - Date.now();
const clock = `elapsed ${fmt(elapsed)} | remaining ${fmt(remaining)}`;

if (needs === null) {
  console.log(`${clock} | ${remaining <= 0 ? "EXPIRED — stop work" : "running"}`);
  process.exit(remaining <= 0 ? 2 : 0);
}

let decision;
try {
  decision = decide({ remainingMs: Math.max(0, remaining), needsMs: needs, reserveMs: reserve });
} catch (error) {
  if (error instanceof GateError) usage(error.message);
  throw error;
}
const verdict = decision.expired
  ? "EXPIRED — stop work"
  : decision.ok
    ? `fits, ${fmt(decision.spareMs)} spare`
    : `DOES NOT FIT — ${fmtShort(decision.shortByMs)} short`;
console.log(
  `${clock} | needs ${fmt(needs)} + ${fmt(reserve)} reserve = ${fmt(decision.neededMs)} | ${verdict}`,
);
process.exit(decision.ok ? 0 : 2);
