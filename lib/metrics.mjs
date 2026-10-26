// The metrics this project exists to measure.
//
// Every existing tool reports whether a run *ended* on time. None reports the
// decision that comes first: was this work worth starting with the time that was
// left? These two numbers describe that, and they have to be read together —
// refusing everything drives premature starts to zero and is worthless, so a
// high starved-refusal rate is the price of guarding the gate too hard.
//
// prematureStart: the agent began work whose measured cost exceeded the budget
//   remaining when it began. The work cannot finish; the session ends
//   mid-surgery.
// starvedRefusal: the agent declined work that would have fit. The budget was
//   spent idle instead of on the work available.

export function classify(record) {
  const { started, trueCostMs, remainingAtStartMs, reserveMs = 0 } = record;
  // "Fits" uses the same rule the gate uses: the work plus its verification
  // reserve. Without the reserve, a correct refusal of work that fits but cannot
  // be verified would be scored as starving the session.
  const fits = trueCostMs + reserveMs <= remainingAtStartMs;
  return {
    prematureStart: started && !fits,
    starvedRefusal: !started && fits,
    started,
    fits,
  };
}

const rate = (count, total) => (total === 0 ? null : count / total);

export function summarize(records) {
  const arms = new Map();
  for (const record of records) {
    if (!arms.has(record.arm)) arms.set(record.arm, []);
    arms.get(record.arm).push({ ...record, ...classify(record) });
  }
  const rows = [];
  for (const [arm, group] of arms) {
    const started = group.filter((r) => r.started);
    const usedMs = started.reduce((sum, r) => sum + r.runtimeMs, 0);
    // One budget per session, not per record: records in a session share a pot.
    const budgets = new Map(group.map((r) => [r.sessionId ?? r.taskId, r.budgetMs]));
    const totalBudgetMs = [...budgets.values()].reduce((sum, ms) => sum + ms, 0);
    const overruns = started
      .filter((r) => r.runtimeMs > r.remainingAtStartMs)
      .map((r) => r.runtimeMs - r.remainingAtStartMs)
      .sort((a, b) => a - b);
    rows.push({
      arm,
      n: group.length,
      started: started.length,
      prematureStarts: group.filter((r) => r.prematureStart).length,
      prematureStartRate: rate(group.filter((r) => r.prematureStart).length, group.length),
      starvedRefusals: group.filter((r) => r.starvedRefusal).length,
      starvedRefusalRate: rate(group.filter((r) => r.starvedRefusal).length, group.length),
      completed: started.filter((r) => r.finished).length,
      overranBudget: started.filter((r) => r.overranBudget).length,
      medianOverrunMs: quantile(overruns, 0.5),
      usedMs,
      // What share of the budget was spent on work, as opposed to left idle.
      utilisation: totalBudgetMs === 0 ? null : usedMs / totalBudgetMs,
    });
  }
  return rows.sort((a, b) => a.arm.localeCompare(b.arm));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
