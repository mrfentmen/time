#!/usr/bin/env node
// Wall-clock budget for a work session. `start` begins it; `check` prints
// elapsed and remaining and exits 2 once the budget is spent, so a shell can
// gate further work on it.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.TIMER_STATE ?? "/tmp/time-timer.json";
const minutes = Number(process.env.MINUTES ?? 30);
const cmd = process.argv[2] ?? "check";

if (cmd === "start") {
  writeFileSync(file, JSON.stringify({ start: Date.now(), minutes }));
  console.log(`timer started: ${minutes} minutes`);
  process.exit(0);
}

const t = JSON.parse(readFileSync(file, "utf8"));
const elapsed = Date.now() - t.start;
const remaining = t.start + t.minutes * 60000 - Date.now();
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
console.log(
  `elapsed ${fmt(elapsed)} | remaining ${fmt(remaining)} | ${remaining <= 0 ? "EXPIRED — stop work" : "running"}`,
);
process.exit(remaining <= 0 ? 2 : 0);
