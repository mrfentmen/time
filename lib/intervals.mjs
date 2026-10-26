// Rates from the bench are pooled over decisions, but decisions inside one session
// are not independent: an agent that overruns once tends to overrun again. So the
// interval has to resample *sessions*, not records — twelve records from one session
// are one observation of a policy, and a naive binomial interval would be far too
// narrow. This is the smallest honest version of that.
//
// Deterministic by construction: a fixed seed and an explicit generator, so the same
// records always print the same interval and a report can be reproduced.

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// sessions: array of arrays of records. Each inner array is one session.
export function bootstrapRate(sessions, { iterations = 2000, seed = 12345 } = {}) {
  const random = lcg(seed);
  const rates = [];
  for (let i = 0; i < iterations; i++) {
    let premature = 0;
    let total = 0;
    for (let j = 0; j < sessions.length; j++) {
      const pick = sessions[Math.floor(random() * sessions.length)];
      for (const record of pick) {
        total++;
        if (record.prematureStart) premature++;
      }
    }
    if (total > 0) rates.push(premature / total);
  }
  if (rates.length === 0) return { low: null, high: null };
  rates.sort((a, b) => a - b);
  const at = (q) => rates[Math.min(rates.length - 1, Math.max(0, Math.round((rates.length - 1) * q)))];
  return { low: at(0.025), high: at(0.975) };
}

// Pooled over records, with the session as the unit of resampling.
export function rateWithInterval(sessions) {
  const records = sessions.flat();
  const premature = records.filter((record) => record.prematureStart).length;
  return {
    decisions: records.length,
    premature,
    rate: records.length === 0 ? null : premature / records.length,
    interval: bootstrapRate(sessions),
    sessions: sessions.length,
  };
}
