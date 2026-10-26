#!/usr/bin/env node
// Rates and intervals from a finished bench run.
//
// `bench/run.mjs` prints counts; this turns them into a rate with an interval that
// resamples sessions rather than decisions, because twelve records from one session
// are one observation of a policy. Every number in REPORT.md that says "x/n (y%)"
// next to an interval comes from here.
//
//   node bench/analyze.mjs bench/results/e2e-40s.json
//   node bench/analyze.mjs bench/results/e2e-40s.json bench/results/e2c-60s.json
import { readFileSync } from "node:fs";
import { classify } from "../lib/metrics.mjs";
import { rateWithInterval } from "../lib/intervals.mjs";

const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (files.length === 0) {
  console.error("usage: node bench/analyze.mjs <result.json> [more.json]");
  process.exit(64);
}

const pct = (value) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const one = (value) => (value === null ? "—" : value.toFixed(1));

for (const file of files) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(65);
  }
  const records = (payload.records ?? []).map((record) => ({ ...record, ...classify(record) }));
  const arms = [...new Set(records.map((record) => record.arm))].sort();
  const sessions = payload.sessions ?? [];

  console.log(
    `\n${file}\n${payload.scenario ?? "?"} · ${payload.adapter ?? "?"} · ` +
      `${payload.invocation ?? "per-task"} · ${(payload.budgetMs ?? 0) / 1000}s budget · ` +
      `${records.length} records`,
  );

  const header = ["arm", "sessions", "decisions", "premature", "95% CI", "starved", "utilisation", "s/decision"];
  const rows = [];
  for (const arm of arms) {
    const own = records.filter((record) => record.arm === arm);
    const bySession = new Map();
    for (const record of own) {
      const id = record.sessionId ?? record.taskId;
      if (!bySession.has(id)) bySession.set(id, []);
      bySession.get(id).push(record);
    }
    const grouped = [...bySession.values()];
    const stats = rateWithInterval(grouped);
    const budget = own[0]?.budgetMs ?? 0;
    const utilisation =
      grouped.reduce((sum, group) => {
        const used = group.filter((r) => r.started).reduce((n, r) => n + r.runtimeMs, 0);
        return sum + (budget === 0 ? 0 : used / budget);
      }, 0) / grouped.length;
    const logs = sessions.filter((session) => session.arm === arm);
    const wallMs = logs.reduce((sum, session) => sum + session.wallClockMs, 0);
    const workMs = own.reduce((sum, record) => sum + record.runtimeMs, 0);
    const decisions = own.filter((record) => record.started).length;
    rows.push([
      arm,
      String(grouped.length),
      String(stats.decisions),
      `${stats.premature} (${pct(stats.rate)})`,
      stats.interval.low === null ? "—" : `[${pct(stats.interval.low)}, ${pct(stats.interval.high)}]`,
      `${own.filter((record) => record.starvedRefusal).length}`,
      pct(utilisation),
      logs.length === 0 || decisions === 0 ? "—" : one((wallMs - workMs) / decisions / 1000),
    ]);
  }

  const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column].length), header[column].length));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log(
    "\n95% CI resamples sessions, not records: decisions inside one session are not independent.\n" +
      "utilisation is the mean share of each session's budget spent on work; s/decision is\n" +
      "(session wall clock - work) / decisions taken, the overhead the budget also pays for.",
  );
}
