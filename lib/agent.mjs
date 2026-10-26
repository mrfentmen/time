// A failed agent invocation must not become a result.
//
// The E4a run hit opencode's free-usage ceiling partway through its third arm. Each
// failed session exited in 0.2s with no output and no task markers, and the bench —
// which only ever asks "did the work start?" — scored twelve refusals per session.
// Those refusals looked like a gate starving a session: 57% starved, 18% utilisation.
// It was a quota error. This guard exists so the next one is an error, not a table.

export class AgentFailure extends Error {}

// `killed` is a measurement (the supervisor cut the run off at its cap), so it is
// not a failure. Any other non-zero exit is.
export function assertAgentSucceeded({ code, killed = false, agentOutput = "", agentStderrTail = "" }) {
  if (killed || code === 0) return;
  const detail = (agentStderrTail || agentOutput || "")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-2)
    .join(" ");
  throw new AgentFailure(`agent exited ${code}${detail ? ` — ${detail}` : " with no output"}`);
}
