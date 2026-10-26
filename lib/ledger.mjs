// An append-only record of what was planned and what it actually cost. It exists
// so the gate's estimates can be corrected from observed data instead of
// intuition: forecasts miss by a stable factor, and a stable factor is
// measurable.
//
// One JSON object per line, in the order things happened. Nothing is ever
// rewritten, so a summary can always be recomputed from the file.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function appendEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

// Tolerant of blank lines and of a file that does not exist yet.
export function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export function openPlan(events) {
  const open = new Map();
  for (const event of events) {
    if (event.type === "plan") open.set(event.id, event);
    if (event.type === "done") open.delete(event.id);
  }
  return [...open.values()];
}

// Pairs each plan with its done event. Unfinished plans are dropped: you cannot
// score an estimate against a task that never ended.
export function completedItems(events) {
  const plans = new Map();
  const done = new Map();
  for (const event of events) {
    if (event.type === "plan") plans.set(event.id, event);
    if (event.type === "done") done.set(event.id, event);
  }
  const items = [];
  for (const [id, plan] of plans) {
    const end = done.get(id);
    if (!end) continue;
    items.push({
      id,
      label: plan.label,
      class: plan.class ?? "untagged",
      estimateMs: plan.estimateMs ?? null,
      actualMs: end.actualMs,
      status: end.status ?? "ok",
    });
  }
  return items;
}

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// Per class: how many items, the median estimate and actual, the 90th percentile
// actual, and the bias factor — the geometric mean of actual/estimate, which is
// the number to multiply an estimate by to make it honest. 1.4 means "everything
// takes 40% longer than I say".
export function calibration(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.class)) groups.set(item.class, []);
    groups.get(item.class).push(item);
  }
  const rows = [];
  for (const [cls, group] of groups) {
    const actual = group.map((i) => i.actualMs).sort((a, b) => a - b);
    const estimates = group
      .map((i) => i.estimateMs)
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b);
    const ratios = group
      .filter((i) => Number.isFinite(i.estimateMs) && i.estimateMs > 0)
      .map((i) => i.actualMs / i.estimateMs);
    const bias =
      ratios.length > 0
        ? Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length)
        : null;
    rows.push({
      class: cls,
      n: group.length,
      estimateP50: quantile(estimates, 0.5),
      actualP50: quantile(actual, 0.5),
      actualP90: quantile(actual, 0.9),
      bias,
    });
  }
  return rows.sort((a, b) => b.n - a.n || a.class.localeCompare(b.class));
}
