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

# E2: the ladder, 2026-10-25

The same three arms over a session of twelve tasks, at three budgets. 108 live runs.
Records: [`bench/results/e2-20s.json`](bench/results/e2-20s.json),
[`e2-80s.json`](bench/results/e2-80s.json), [`e2-320s.json`](bench/results/e2-320s.json).

## Setup

- 12 tasks, 1–7s each, 45.5s of work in total, one shared pot per session.
- Budgets of 20s, 80s and 320s — a 1×/4×/16× ladder relative to a 20s base.
- Every arm is offered every task in the same order, including after the pot is
  empty, so `n` is 12 everywhere and "did it keep starting with nothing left?" is
  measured rather than hidden by an early stop.
- Verification reserve 1s per decision; one repeat per cell.

## Result

Premature starts (began work that could not be finished and verified in the time left):

| budget | blind | aware | gated |
|---|---|---|---|
| 20s | 10/12 (83%) | 10/12 (83%) | **0/12** |
| 80s | 5/12 (42%) | 5/12 (42%) | **0/12** |
| 320s | 0/12 | 0/12 | **0/12** |
| **total** | **15/36 (42%)** | **15/36 (42%)** | **0/36** |

The rest of the picture, which the table above cannot show:

| arm | started | after the pot was empty | starved refusals | utilisation (tight arms) |
|---|---|---|---|---|
| blind | 36/36 | 15 | 0 | 760–194% |
| aware | 36/36 | 14 | 0 | 805–190% |
| gated | 18/36 | 0 | 2 | 62–89% |

## What this shows

**Awareness still changed nothing.** Identical counts, identical per-budget split:
15 premature starts in both arms. Twelve live runs per budget in which the agent
could ask how much time was left, and it started the same work a blind agent
started, including 29 runs that began after the pot was already empty.

**The gate eliminated premature starts — and paid for it in idle time.** 0/36 at
every budget, but it refused half of all offers, never worked past the pot, and left
38% of the 20s budget and 11% of the 80s budget unused. It also refused twice when
the work would have fitted. That is the trade the two metrics exist to expose: a
gate can always reach zero premature starts by refusing everything, and the
starved-refusal column is what stops that from looking like success.

**At 320s the question disappears.** Every arm completed all twelve tasks with no
premature starts, because everything fitted. A gate earns its keep only when time
is scarce; agent benchmarks that measure one generous budget are measuring nothing.

## A measurement finding we did not set out to get

The per-decision latency of the agent is **8–12s**. In the 20s arm, after an
invocation that started a 1s task, the pot showed **7.6s left** — one decision's
overhead had eaten 12.4s of a 20s budget. So the 20s arm measures agent startup as
much as judgement, and any budget within an order of magnitude of a single decision's
latency is degenerate. The gate's own refusals inherit this: it evaluates
`cost + reserve` against a remaining time that has already been reduced by the
agent's thinking. That is honest — thinking is part of a budget — but it means the
smallest arm is a floor test, not a clean contrast, and it is why the 80s and 320s
arms carry the argument.

## Limits

One repeat per cell, one model, one harness, synthetic tasks whose costs are stated
in the prompt, and the gated arm is still the only arm given an explicit rule. 108
runs is enough to see a direction and not enough to put an error bar on it. E1's
refusal design — one task, equal opportunities, no latency confound — remains the
cleaner of the two experiments.

## Next

1. **E2b** — rerun the ladder with budgets ≥10× per-decision latency (200s/800s/3.2ks)
   or, better, one agent invocation per session instead of one per task, so overhead
   stops being a term in the budget. The second option also makes the session real:
   the agent carries its own context between decisions.
2. **E4** — repeat E1 and E2b under a second harness, since AgentTime found model
   effects dominate harness effects (slopes moved 0.14–0.16 by harness, 0.69–0.71 by
   model).
3. **E3** — five real sessions through `plan`/`done`/`report`, to see whether the
   per-class bias converges enough to replace the hand-written estimate the gate
   currently receives.

Replication is one command; the file name carries the date:

```sh
node bench/run.mjs --adapter cli --scenario refusal --tasks bench/tasks/refusal.json \
  --arms blind,aware,gated --repeats 3 --reserve 2000ms --cap 90s \
  --out bench/results/live-refusal-$(date +%F).json
```
