# Design: what this is trying to show

A timer that reports the time is a solved problem (chronos, Docker Agent budgets).
A timer that stops work is a solved problem (Docker's `max_time`, Overnight
Experimenter's budget). The unsolved problem is the decision *before* the work:
**should this be started with the time that is left?** Every project in
[`PRIOR_ART.md`](PRIOR_ART.md) measures or enforces time after that decision has
already been made, and AgentTime — the benchmark that measures duration-following
properly — deliberately does not enforce anything.

The claim this repo is built to test, in one sentence:

> Knowing how much time is left does not change what an agent starts. A gate that
> answers "does this fit?" does.

If that is false — if a clock alone produces the same behaviour — then the thesis
here is wrong and this repo should say so in public, because the entire field is
currently shipping clocks.

**E2b and E2c qualified it, and the qualification is the more useful sentence.** With
one agent invocation per session instead of one per task, a cheap clock *is*
consulted: over three repeats at a 60s budget the aware arm fell from 10/12
premature starts to **1/36 (3%)**, against blind at 6/36 (17%) — and the gate still
went one better at **0/36**, for about 8 points of utilisation. So the claim as
written holds in a per-task harness — the shape most agent benchmarks use — and
mostly fails in a continuous session, where the gate keeps a small residual edge
instead of being the only thing that works. What survives is narrower and testable:
**a gate substitutes for a clock an agent will consult, and buys least where the
agent already has the session in view.** [`REPORT.md`](REPORT.md) carries every run,
including the one where an intermediate reading was over-stated and corrected.

## Three things, in order of what they cost to be wrong about

1. **Premature start** — began work that could not be finished *and verified* in the
   time left. The session ends mid-surgery. This is the failure the 2026-10-25
   session avoided by hand.
2. **Starved refusal** — declined work that would have fit, leaving the budget idle.
   The obvious way to game (1), and therefore the number that has to be reported
   beside it.
3. **Calibration** — the gate's estimates against observed actuals. AgentTime found
   forecasts are wrong by a *stable* factor (2.6×–3.8× too high, compression
   exponents 0.89–1.12), and a stable factor is correctable per class from a ledger
   instead of a hunch.

Read as a pair, (1) and (2) are a control problem: guard the gate too hard and you
starve the session; not at all and you end every session mid-refactor.

## The ladder

The independent variable is how much the agent is told, in three steps. Every arm
gets the same task and the same declared cost estimate, so the only difference is
information.

| arm | what it has | what it should do |
|---|---|---|
| `blind` | a shell, no clock | unknown — this is the baseline |
| `aware` | `time.mjs check` — remaining time | the hypothesis says: still starts |
| `gated` | `time.mjs check --needs` — a yes/no | declines what cannot fit |

`aware` versus `gated` is the whole experiment. `blind` is the control that stops
us from claiming credit for "having any clock at all".

### Two confounds, stated up front

- **The gated arm is also given a rule** ("exit 2 means do not start"). A tool needs
  documentation to be used, so this measures a tool plus one sentence of
  instruction. The aware arm is told what its tool prints for the same reason. What
  neither arm is told is the right answer.
- **The estimate is given to every arm**, because the gate needs one and withholding
  it from the others would flatter the gate. Compare arms, not absolutes.

## The instrument

`bench/run.mjs` is a supervisor. It owns the clock; the agent gets a state file it
can *read* through the tool and cannot write. `started` and `finished` come from
marker files written by the task's own work script, not from the agent's report of
itself — an agent that says "done" without running anything is recorded as not
started. Elapsed time is measured outside the agent's process, the same discipline
AgentTime uses by keeping its timer outside the container.

```
$ node bench/run.mjs --adapter cli --scenario refusal \
    --tasks bench/tasks/refusal.json --arms blind,aware,gated \
    --repeats 3 --reserve 2000ms --cap 90s
```

Two scenarios:

- **`refusal`** — one task per session, with 80% of the task's own cost left. Starting
  it is always a mistake; declining it is always correct. Equal opportunities per
  arm, so the rates are directly comparable.
- **`session`** — one shared pot of time, tasks taken in order until it is gone. This
  is the realistic case and the one where a blind agent keeps starting work after the
  budget has expired. Refusals cost no time, so arms see different numbers of tasks;
  `n` is reported per arm for that reason.

`--invocation per-session` gives the agent the whole session instead of one task:
the adapter writes every task into its own directory with a task list and one
budget, then starts the CLI once. Each task's work script still stamps `.started`
and `.done`, so the supervisor reconstructs every decision from files rather than
from the reply. Startup is paid once and the agent carries its context across
decisions, which is both cheaper and closer to a real session.

```
$ node bench/run.mjs --adapter cli --invocation per-session --scenario session \
    --tasks bench/tasks/e2.json --budget 120s --arms blind,aware,gated \
    --out bench/results/e2b-120s.json
```

`--adapter scripted` replaces the model with three deterministic policies (always
start / check then start / gate), in both invocations. It exists so the instrument
can be tested in CI without tokens. Its numbers are an upper bound on what the gate
can do, never a result.

### The latency constraint

A decision costs the agent 8–12s of wall clock before any work happens, and that
overhead is charged to the same pot. E2 measured it directly: after one 1s task in a
20s session, 12.4s of the budget was gone. So a budget within an order of magnitude
of one decision's latency measures startup, not judgement, and the gate inherits the
artefact — it compares `cost + reserve` against a remaining time the agent's own
thinking has already spent.

The rule for any future run: **budget ≥ 10× per-decision latency**, or one agent
invocation per session so that overhead is paid once rather than per task. The
second is the better design and the one E2b uses. It also shrinks the latency it
has to divide by: with no process startup between decisions, a turn costs a few
seconds, so budgets in the tens of seconds stop being startup measurements.

## Experiments

| # | question | design | n | status |
|---|---|---|---|---|
| E1 | does the gate change whether work is started? | refusal, 1 task, 3 arms × 3 repeats | 9 | **run** — see [`REPORT.md`](REPORT.md) |
| E2 | does that hold across a session with real choices? | session, 12 tasks, 3 arms × 3 budgets × 1 repeat | 108 | **run** — see [`REPORT.md`](REPORT.md) |
| E2b | does the ladder survive paying startup once, in one invocation? | session, 12 tasks, 3 arms × 2 budgets (60s, 120s), per-session invocation | 6 | **run** — see [`REPORT.md`](REPORT.md) |
| E2c | does the E2b reading survive repetition? | 60s cell × 3 repeats, 3 arms | 108 | **run** — see [`REPORT.md`](REPORT.md) |
| E3 | does the calibration loop make the gate's estimates honest? | ledger bias per class over ≥5 sessions | — | instrument built, needs use |
| E4 | does the effect hold across models? | E2 with a second harness | 324 | not run |

Cost of E1: nine runs of a coding-agent CLI, about five minutes and ~200k tokens.
Cost of E2: a few hundred runs; at AgentTime's scale (3,442 runs, ~$93k) this is
still two orders of magnitude cheaper, because the tasks are short and the arms
share a task set.

### Falsification

The thesis dies if `aware` ≈ `gated` on premature starts across E1 and E2, or if
`gated` only wins by starving the session (starved-refusal rate rises with it). Both
outcomes get published in `REPORT.md` with the records attached; a tool that
silently works around a negative result is worth less than one that reports it.

The first clause appeared to fire in E2b: at a 60s budget in a continuous session,
aware and gated both scored 0 premature starts, and gated used *less* of the budget.
Three repeats (E2c) walked it back to a narrow survive — aware 1/36, gated 0/36 — so
the clause is reported as weakened rather than confirmed, with the instrument change
that caused it named and the correction published alongside the first reading.

## What this does not claim

- **Enforcement.** The gate is advisory. An agent that can write the state file can
  lie to itself, and an agent that ignores `exit 2` is only caught by a supervisor
  (`bench/run.mjs` is one). Any "enforcement" language in the README would be false.
- **Generality from one task.** E1 is one synthetic build in one harness. It is a
  pilot that shows the instrument works and gives a direction, not a finding about
  agents in general.
- **That shorter is better.** Premature-start rate is not a quality metric. AgentTime
  found that 16× more time improved the score on only 23–25% of tasks — which is why
  a gate should ask "is this worth starting?" rather than "can I squeeze it in?".

## Data

Every run writes a JSON file with the summary and every record, including the agent's
own final line. `bench/results/` is committed: the records are the claim. Re-running
`--adapter cli` against a different model is the replication, and the file name
carries the date.
