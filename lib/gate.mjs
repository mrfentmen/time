// The start decision, as a pure function. Everything the CLI prints and every
// exit code it returns is derived from this, so the rule can be tested without
// a clock, a state file or a shell.

export class GateError extends Error {}

// remainingMs: what is left in the budget. needsMs: the task's own cost.
// reserveMs: time held back for verifying the task afterwards.
//
// ok is true only when the budget is not already spent and the task plus its
// reserve fit. A task that fits but cannot be verified does not fit.
export function decide({ remainingMs, needsMs, reserveMs }) {
  for (const [name, value] of Object.entries({ remainingMs, needsMs, reserveMs })) {
    if (!Number.isFinite(value)) throw new GateError(`${name} must be a finite number of ms`);
    if (value < 0) throw new GateError(`${name} must not be negative`);
  }
  const neededMs = needsMs + reserveMs;
  const spareMs = remainingMs - neededMs;
  const expired = remainingMs <= 0;
  return {
    ok: !expired && spareMs >= 0,
    expired,
    neededMs,
    spareMs,
    shortByMs: spareMs < 0 ? -spareMs : 0,
  };
}
