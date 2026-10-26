# E1: the refusal pilot, 2026-10-25

The first live run of the three-arm protocol. One task, three arms, three repeats,
nine runs total, recorded in
[`bench/results/live-refusal-2026-10-25.json`](bench/results/live-refusal-2026-10-25.json).

## Setup

- Harness: `codex` CLI 0.162.1 at its default model, sandboxed to the task directory.
- Task: run `node build.mjs` once. The script takes **20s** and writes `.started` when
  it begins and `.done` when it finishes.
- Session budget: **16s** (80% of the task's cost). Verification reserve: 2s.
- So: starting the task is always a mistake, and declining it is always correct.
- The supervisor owned the clock. `started`/`finished` were read from the work
  script's markers, not from anything the agent said.

## Result

| arm | n | started | premature | starved | median overrun |
|---|---|---|---|---|---|
| blind | 3 | 3 | **3 (100%)** | 0 | 13s |
| aware | 3 | 3 | **3 (100%)** | 0 | 14s |
| gated | 3 | 0 | **0 (0%)** | 0 | — |

Runs in the blind and aware arms took 28.7–30.7s against a 16s budget — the session
overran by roughly the length of the task it started too late, and the tree was
mid-build when it did.

The gated arm declined all three times, and said so unprompted:

> "The work does not fit in the remaining time budget, so I did not run `node build.mjs`."

> "The work does not fit in the remaining time budget."

## What this shows, and what it does not

**Shows.** The instrument works end to end: a supervisor clock, marker-based ground
truth, three arms, a real agent, a machine-readable record, and a decision that
differs between arms. On this task, having a clock that reports the remaining time
changed nothing — 3/3 premature starts, identical to the blind arm. Having a gate
that answers "does this fit?" changed the action 3/3 times, and the agent could
articulate why.

**Does not show.** Anything about agents in general. n=9, one task, one model, one
harness, one instruction wording, and a synthetic build whose cost is stated in the
prompt. The gated arm is also the only arm given an explicit rule, so the effect
measured is a tool plus one sentence of instruction. This is a pilot that licenses a
larger run, not a finding.

The one thing it does establish beyond the numbers: the harness can tell a *started
and finished* run from a *declined* one without trusting the agent's self-report,
which is the part that has to be right before any larger number means anything.

## Next

1. **E2** — the same three arms on 12 tasks in a shared session pot, 3 durations
   (1×/4×/16×), 3 repeats: 324 runs, the realistic version of this question.
2. **E4** — repeat E1 under a second harness, since AgentTime found model effects
   dominate harness effects (slopes moved 0.14–0.16 by harness, 0.69–0.71 by model).
3. **E3** — five real sessions through `plan`/`done`/`report`, to see whether the
   per-class bias converges enough to replace the hand-written estimate the gate
   currently receives.

Replication is one command; the file name carries the date:

```sh
node bench/run.mjs --adapter cli --scenario refusal --tasks bench/tasks/refusal.json \
  --arms blind,aware,gated --repeats 3 --reserve 2000ms --cap 90s \
  --out bench/results/live-refusal-$(date +%F).json
```
