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

# E2b: paying startup once, 2026-10-25

E2's latency finding said the instrument, not the judgement, was setting the numbers:
one agent invocation per task charged 8–12s of startup and thinking to a shared pot.
E2b changes only that. The same twelve tasks and the same three arms, but **one
invocation per session**: the agent is handed the task list and the budget once and
decides for itself what to start, in a single process. Records:
[`bench/results/e2b-60s.json`](bench/results/e2b-60s.json),
[`e2b-120s.json`](bench/results/e2b-120s.json). 72 records, six sessions.

## Setup

- 12 tasks, 1–7s each, 45.5s of work, one shared pot — identical to E2.
- Each task in its own directory; each work script stamps `.started` and `.done`, so
  every decision is reconstructed from files, not from the agent's reply.
- Budgets of **60s** (1.3× the work) and **120s** (2.6×). Reserve 1s per decision.
- One repeat per cell: each arm at each budget is **one session**.

## Result

Premature starts (began work that could not be finished and verified in time left):

| budget | blind | aware | gated |
|---|---|---|---|
| 60s | 3/12 (25%) | **0/12** | **0/12** |
| 120s | 0/12 | 0/12 | 0/12 |
| **total** | **3/36 (8%)** | **0/36** | **0/36** |

At 60s, where the budget actually bites:

| arm | started | after the pot was empty | starved | wall clock | utilisation |
|---|---|---|---|---|---|
| blind | 12/12 | 2 | 0 | **76.7s — 16.7s past the bell** | 76% |
| aware | 11/12 | 0 | 0 | 59.5s | 64% |
| gated | 10/12 | 0 | 0 | 58.2s | 54% |

The blind session ran `t11-docs` (6s) and `t12-deploy` (7s) with the pot already at
zero. The aware session asked, saw 10.8s left before `t11`, ran it, then saw 0.5s
before `t12` and stopped — the only refusal it made, and the right one. The gated
session refused `t11` and `t12` at 1.8s left, both correctly, and ended with 1.8s
idle.

## What this shows

**Startup paid once is 6–9× cheaper per decision.** Wall clock minus work, divided by
decisions: **1.2–3.4s** here against 8–12s in E2. That alone repairs the instrument
E2 flagged as degenerate — budgets in the tens of seconds stop being startup tests.

**Half of the thesis fails here, and it is the half worth keeping honest.** The claim
in `DESIGN.md` is that a clock does not change what an agent starts. In a continuous
session it does: aware went from **10/12 premature in E2 to 0/12**, and it declined
the last task for the correct reason. The mechanism is visible in the numbers — with
one invocation the agent keeps the session in view, so a cheap `check` is something it
actually consults between decisions, whereas a fresh per-task prompt has no session
to pace.

**The gate bought nothing over the clock in this session.** Both scored 0, and the
gate paid for its 0 in idle time: 54% utilisation against 64%, two refusals against
one, 1.8s of the pot left unused. Its refusals were correct, but so was the clock's
one, and the clock's owner reasoned about the fit itself. What E1 and E2 measured as
the gate's advantage may be the advantage of a clock an agent will *use* — which is a
statement about continuity and prompt shape, not about the gate as a separate idea.
E2c repeats this cell three times and corrects this paragraph: the gate does catch a
decision the clock misses.

**Continuity alone is not enough.** The blind arm had the same session context and
still ran 16.7s past the bell, starting two tasks at zero. Session shape lowered
blind from 83% to 25% premature; the clock is what removed the rest.

**A generous budget measures nothing, for the third time.** At 120s every arm ran all
twelve tasks and scored 0 — 45.5s of work plus ~2s per decision fits inside 120s.
Budget has to be tight relative to work before any arm can fail.

## Limits

- **One session per cell.** 12 records per arm is not 12 independent observations;
the unit is the session, so 3 versus 0 is one session versus one session. E2b is a
direction with a mechanism attached, not a rate.
- The costs are printed in the task list and exact, so every arm can do the arithmetic
itself. AgentTime's forecasts miss by 2.6–3.8×; here the estimates are perfect, which
flatters all three arms and the gate least.
- One model, one harness, synthetic tasks. Same caveats as E2.

# E2c: three repeats at 60s, and a correction

E2b's sharpest sentence — the gate bought nothing over the clock — was drawn from
**one session per arm**. This repeats that tight cell three times: nine sessions, 108
records, same twelve tasks, same 60s budget. Records:
[`bench/results/e2c-60s.json`](bench/results/e2c-60s.json).

## Result

| arm | premature | 95% CI (sessions) | after the pot was empty | started | refused | starved | utilisation |
|---|---|---|---|---|---|---|---|
| blind | **6/36 (17%)** | 8–25% | 3 | 36/36 | 0 | 0 | 76% |
| aware | **1/36 (3%)** | 0–8% | 0 | 36/36 | 0 | 0 | 76% |
| gated | **0/36 (0%)** | none in 3 sessions | 0 | 34/36 | 2 | 0 | 68% |

The interval resamples sessions, not decisions (`bench/analyze.mjs`), because records
inside one session move together. Gated's zero is printed as "none in 3 sessions"
rather than an interval: with no event the bootstrap collapses to a point, and a point
would read as certainty the data does not support.

Per session:

- **blind** — 3, 2 and 1 premature starts; all three sessions ran past the bell
  (81.4s, 76.5s, 63.7s against 60s) because it kept starting after the pot was empty.
- **aware** — one bad start: `t12-deploy` (7s) with **3.4s** left. The other two
  sessions finished clean.
- **gated** — refused `t12` in two sessions, at 0ms and 3524ms left, both correctly;
  in the third session everything fitted. No starved refusals.

## Correction

**The gate caught the decision awareness missed.** Over three sessions the aware arm
started 7s of work with 3.4s left; the gated arm never did, made both of its refusals
correctly, and paid about 8 points of utilisation for it. E2b called the gate
redundant on the strength of one session where both scored 0, and that reading does
not survive repetition.

The correction also has a size. 1/36 against 0/36 is **one decision**, not a
difference between policies: it says E2b's sentence was over-read, not that the gate
is vindicated. Three sessions per arm cannot separate 3% from 0%.

## The revised picture at 60s

In a continuous session: **blind 17% → aware 3% → gated 0%** premature starts.
Continuity and a cheap clock remove most of the failure; the gate removes the rest,
for about 8 points of utilisation and no starved refusals. The gate is worth
something, but far less than in E2 — where, with one invocation per task, it was the
only arm that changed anything at all.

# E2d: a tighter cell, 40s, and a bug it caught

One session per arm at a 40s budget — tight enough that several decisions per session
are at risk, which is what E2b and E2c lacked. Records:
[`bench/results/e2d-40s.json`](bench/results/e2d-40s.json).

| arm | premature | after the pot was empty | started | starved | utilisation |
|---|---|---|---|---|---|
| blind | 3/12 (25%) | 2 | 12/12 | 0 | 114% — 19.8s past the bell |
| aware | 1/12 (8%) | 0 | 8/12 | 0 | 55% |
| gated | 0/12 (0%) | 0 | 9/12 | 0 | 68% |

The ordering holds at the tighter budget (25% → 8% → 0%), and this time the gate is
not the most idle arm: it used 68% of the pot against the clock's 55%, with no
starved refusal. n=1 session per arm, so it is a direction, not a rate.

**The bug it caught first.** The first attempt at this cell was thrown away: the
gated prompt told the agent to run `check --needs <cost in ms>`, a placeholder rather
than each task's cost. The agent ran it literally, got exit 64, read that as "does not
fit", and refused all twelve tasks in 13.4s — 33% starved refusals, 30% utilisation.
Published without reading the transcript, that would have been a finding about the
gate starving sessions. It was a finding about a prompt. The prompt now spells out one
copyable command per task, and a test asserts each task's own cost appears and no
placeholder survives. The discarded run is described here rather than deleted, because
the failure mode — an instrument error that looks exactly like the result you expect —
is the one this repo exists to make visible.

# E2e: ten sessions per arm, 2026-10-25

The 40s cell repeated ten times per arm — thirty sessions, 360 records — because
E2d could only say "a direction". Records:
[`bench/results/e2e-40s.json`](bench/results/e2e-40s.json), intervals from
`bench/analyze.mjs`, which resamples sessions.

## Result

| arm | premature starts | 95% CI (sessions) | sessions with a premature start | started | starved | utilisation |
|---|---|---|---|---|---|---|
| blind | **46/120 (38%)** | 29–48% | 10 of 10 | 116/120 | 0 | 108% |
| aware | **8/120 (7%)** | 3–10% | 7 of 10 | 85/120 | 0 | 63% |
| gated | **0/120 (0%)** | none in 10 sessions | 0 of 10 | 76/120 | 0 | 52% |

Per session, the shape behind the rates:

| arm | wall clock, median (min–max) | time past the bell, total | premature starts per session |
|---|---|---|---|
| blind | 65s (51–95s) against a 40s budget | **316.9s** | 3,4,7,7,6,4,3,7,2,3 |
| aware | 46s (39–53s) | 57.9s | 1,2,0,0,0,1,1,1,1,1 |
| gated | 42s (39–46s) | 18.9s | 0,0,0,0,0,0,0,0,0,0 |

## What this establishes

**The ordering is no longer a single-session artefact.** Blind 38% [29–48] and aware
7% [3–10] do not overlap; gated had no premature start in ten sessions, and the
events are spread across aware's sessions rather than concentrated in one (seven
sessions with one, one with two). This is the first cell in the series with enough
sessions to carry an interval, and the direction from E1 survives it at a budget
where several decisions per session are at risk.

**The trade is now priced.** The gate starts 9 fewer tasks than the clock (76 against
85) and converts that into 8 fewer premature starts, plus about 11 points of
utilisation (52% against 63%) — roughly one completed task given up per premature
start avoided. Blind is the only arm whose utilisation exceeds 100%, and it gets
there by spending 316.9s past the bell across ten sessions.

**Nothing here rescues the original thesis.** The gate is strict dominance over the
clock on this metric, but the clock alone removes five sixths of the blind failure
(38% → 7%). The gate's remaining job is the last 7%, and it pays a third of the work
for it.

## Limits

- Still one model, one harness, one task set, and task costs printed exactly in the
  list, so every arm can do the arithmetic. Real forecasts miss by 2.6–3.8×, which
  would hurt the gate and the clock alike — E3 is the experiment for that.
- "None in 10 sessions" is not zero: at a session level, ten clean sessions are
  consistent with an event rate up to about 26%. It bounds the gate's failure rate,
  it does not measure it at zero.
- The blind arm's 108% utilisation is not effort, it is overrun: the same work
  measured against a budget that had already expired.

## Next

1. **E2f** — the same ten-session cell with *wrong* estimates (multiply the stated
   costs by the bias AgentTime measured), so the gate's p90 calibration is tested
   rather than assumed.
2. **Separate continuity from clock cost** — a per-session aware arm whose clock costs
   a fresh turn, to test the mechanism directly rather than by inference.
3. **E4** — repeat E1 and E2e under a second harness, since AgentTime found model
   effects dominate harness effects (slopes moved 0.14–0.16 by harness, 0.69–0.71 by
   model).
4. **E3** — five real sessions through `plan`/`done`/`report`, to see whether the
   per-class bias converges enough to replace the hand-written estimate the gate
   currently receives; `check --for <class>` is now the consumer of that number.

Replication is one command; the file name carries the date:

```sh
# E1
node bench/run.mjs --adapter cli --scenario refusal --tasks bench/tasks/refusal.json \
  --arms blind,aware,gated --repeats 3 --reserve 2000ms --cap 90s \
  --out bench/results/live-refusal-$(date +%F).json

# E2b
node bench/run.mjs --adapter cli --invocation per-session --scenario session \
  --tasks bench/tasks/e2.json --budget 60s --reserve 1000ms --arms blind,aware,gated \
  --out bench/results/e2b-60s.json

# E2c
node bench/run.mjs --adapter cli --invocation per-session --scenario session \
  --tasks bench/tasks/e2.json --budget 60s --reserve 1000ms --repeats 3 \
  --arms blind,aware,gated --out bench/results/e2c-60s.json

# E2e
node bench/run.mjs --adapter cli --invocation per-session --scenario session \
  --tasks bench/tasks/e2.json --budget 40s --reserve 1000ms --repeats 10 \
  --arms blind,aware,gated --out bench/results/e2e-40s.json
node bench/analyze.mjs bench/results/e2e-40s.json
```
