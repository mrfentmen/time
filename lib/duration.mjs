// Duration parsing and formatting, shared by the CLI and the bench so a
// "budget" means the same thing everywhere.

// Milliseconds, or null when `raw` is not a duration. A bare number is minutes,
// matching MINUTES.
export function parseDuration(raw) {
  if (raw == null || raw === "") return null;
  const ms = /^(\d+)ms$/.exec(raw);
  if (ms) return Number(ms[1]);
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60_000);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !m.slice(1).some((part) => part !== undefined)) return null;
  const [, h, min, s] = m;
  return (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
}

// Floors, so a number never overstates what is left.
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Rounds up, so one second short never prints as "0m 00s short".
export function formatShortfall(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
