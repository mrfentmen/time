# time

A wall-clock budget for a work session, as a single dependency-free Node script.

It exists because "work for 30 minutes" needs to be a thing an agent (or a shell)
can *check*, not a thing it remembers: `check` exits non-zero the moment the
budget is spent, so anything that runs after it can be gated on the result. The
gate goes one step earlier — `check --needs 8m` asks whether there is room to
*finish and verify* something before the budget is gone.

How this compares to the existing work in the field — AgentTime, chronos, Overnight
Experimenter, AgenticTime, Docker Agent budgets — and what to take from each is in
[`PRIOR_ART.md`](PRIOR_ART.md).

## Usage

```sh
node time.mjs start            # begin a 30 minute budget
node time.mjs check            # "elapsed 4m 12s | remaining 25m 48s | running"
```

```sh
# expire it after ten minutes and gate a shell on the result
MINUTES=10 node time.mjs start
node time.mjs check || echo "budget spent, stop here"
```

```sh
# gate *starting* a task on whether it and its verification still fit
node time.mjs check --needs 8m && start_the_task || leave_it_for_next_time
# elapsed 12m 00s | remaining 17m 59s | needs 8m 00s + 3m 00s reserve = 11m 00s | fits, 6m 59s spare
```

```sh
# record what things actually cost, so tomorrow's estimate is not a guess
node time.mjs plan auth-review --estimate 8m --class review
node time.mjs done
# done: auth-review — 9m 12s (estimated 8m 00s, 1.15x)

node time.mjs report
# class     n  est p50  act p50  act p90  bias
# review    4  8m 00s   9m 12s   11m 40s  1.22x
```

## The gate

`check` answers "how much time is left". `check --needs 8m` answers the question
that decides whether a session ends clean: **is there room to finish this, verify
it, and still be stopped rather than mid-surgery?**

It exits `0` only when the remaining budget covers the task *plus a reserve for
verifying it* — typecheck, tests, deploy, smoke, whichever of those the change
needs. The reserve defaults to 3 minutes and is set with `--reserve`, so an
intentionally tiny task can be cleared with `--reserve 1m` and an architectural one
needs more.

The reserve is the whole point. Work that fits but cannot be verified does not fit:
the 2026-10-25 session below is a case of the alternative, where the budget ran out
with the tree green because nothing was left half-applied. A gate without a reserve
would have approved exactly the changes that make an agent stop in the middle of a
refactor at the bell.

Durations accept `90s`, `8m`, `1h30m`, `1500ms`, or a bare number of minutes.

## Calibration

`plan` and `done` write an append-only ledger (`TIME_LEDGER`, default
`.time/ledger.jsonl`); `report` turns it into per-class percentiles and a **bias
factor** — the geometric mean of actual/estimate, which is the number to multiply
an estimate by to make it honest. 1.22× means everything is taking 22% longer than
claimed.

The reason is empirical rather than tidy. AgentTime measured forecasts across three
models and found them wrong by a stable factor in a stable direction: 63–83% too
high, typical misses of 2.6×–3.8×. A bias that stable is not noise, it is a
correction waiting to be applied — per class, from your own data.

The loop closes at the gate: `check --for review` takes that class's **p90 actual**
from the ledger instead of a number typed at the keyboard.

```sh
node time.mjs check --for review --reserve 2m
# elapsed 12m 00s | remaining 17m 59s | needs 9m 12s (p90 of 4 review items) + 2m 00s reserve = 11m 12s | fits, 6m 47s spare
```

p90 rather than the median, because the question is whether there is room to finish
*and* verify, so the tail decides. Below four samples it warns on stderr; with no
history for the class it exits `64` and names the command that would record some. A
gate that quietly guesses is worse than one that says it does not know.

## Tests

```sh
npm test        # 52 tests, nothing to install; node --test, no framework
```

## The bench

`bench/` is the instrument the rest of this file is an argument for: three arms
(`blind`, no clock; `aware`, remaining time; `gated`, a yes/no decision), plus a
fourth (`gated-cal`) that prices the decision from a ledger seeded with a previous
run's measurements (`--calibration-from`), a supervisor that owns the clock, and
ground truth from marker files rather than the agent's self-report. It records **premature starts** (began work that could not be
finished and verified in the time left) beside **starved refusals** (declined work
that would have fitted), because either one alone is trivially gameable.

Live runs default to `--adapter opencode` (`opencode run --auto --model
opencode/glm-5.3-flash-free`). The codex adapter, `--adapter cli`, is kept only so the
E1–E2h records can be reproduced; new measurements use opencode.

```sh
# no tokens: proves the instrument separates the arms
node bench/run.mjs --adapter scripted --scenario refusal --tasks bench/tasks/demo.json

# a real agent, one task, three arms, three repeats
node bench/run.mjs --adapter cli --scenario refusal --tasks bench/tasks/refusal.json \
  --arms blind,aware,gated --repeats 3 --reserve 2000ms --cap 90s \
  --out bench/results/live-refusal-$(date +%F).json

# one agent invocation for a whole session, so startup is paid once
node bench/run.mjs --adapter cli --invocation per-session --scenario session \
  --tasks bench/tasks/e2.json --budget 60s --arms blind,aware,gated \
  --out bench/results/e2b-60s.json

# the same cell three times, which is what a rate needs
node bench/run.mjs --adapter cli --invocation per-session --scenario session \
  --tasks bench/tasks/e2.json --budget 60s --repeats 3 --arms blind,aware,gated \
  --out bench/results/e2c-60s.json

# turn a result file into rates with intervals that resample sessions
node bench/analyze.mjs bench/results/e2c-60s.json
```

The reasoning behind the protocol, the confounds, and what would falsify it are in
[`DESIGN.md`](DESIGN.md). The live runs are in [`REPORT.md`](REPORT.md):

- **E1**, nine runs on one task: blind 3/3 premature starts, aware 3/3, gated 0/3.
- **E2**, 108 runs over twelve tasks at three budgets: **42% premature starts for
  both blind and aware, 0% for gated** — at the cost of refusing half the offers and
  leaving up to 38% of the budget idle. Read the two numbers together.
- **E2b–E2e**, one invocation per session: per-decision overhead fell from 8–12s to
  ~2.5s. Ten sessions per arm at a 40s budget, with session-bootstrap intervals:
  **blind 38% [29–48], aware 7% [3–10], gated none in ten sessions** (0/120 records).
  A cheap clock does most of what a gate did in E2; the gate closes the rest at about
  a third of the completed tasks. `REPORT.md` also documents the prompt bug E2d
  caught — a `<cost in ms>` placeholder that made the gate refuse a whole session and
  read exactly like a real result — and the E2c repeat that corrected an over-read
  E2b.
- **E2g**, estimates inflated 2.6× so they miss the way real ones do: a gate that
  trusts the number starts 17/36 offers, the same gate priced from measured p90
  starts 22/36 with the same zero premature starts, and the clock arm collapses to
  18% utilisation. With the ledger jittered ±40% (E2h pilot) the calibrated arm still
  starts 18% more work, and the noise shows up as one starved refusal rather than a
  half-finished task.

## Contract

| command | writes | exit code |
| --- | --- | --- |
| `start` | state file with start time + budget | `0` |
| `check` | nothing | `0` while running, `2` once expired |
| `check --needs <dur>` | nothing | `0` if the task and reserve fit, `2` if they do not |
| `check --for <class>` | nothing | as `--needs`, with the cost from the ledger's p90; `64` if that class has no completed items |
| `plan` / `done` | one line each to the ledger | `0`, or `64` if a plan is already open |
| `report` | nothing | `0`, including on an empty ledger |
| any, on bad input | nothing | `64` for a bad flag, bad duration, corrupt state, or no timer |

`2` means *do not start*, whether because the budget is spent or because the task
would not fit in what is left — one number for one decision, and the output says
which. It is never `1`, so a budget stop cannot be mistaken for a crash, and it is
never `0` on a usage error, so a typo in a flag cannot silently approve work. The
shell idiom is `node time.mjs check || <stop work>`, and inside a script on `set -e`
the non-zero exit halts it.

## Environment

- `MINUTES` — budget length, default `30`.
- `TIMER_STATE` — state file path, default `/tmp/time-timer.json`.
- `TIME_LEDGER` — ledger path, default `.time/ledger.jsonl`.
- `--reserve <dur>` — the verification reserve the gate adds to `--needs`, default
  `3m`; pass `--reserve 0` only when there is genuinely nothing to verify.

State is a single JSON object (`{ start, minutes }`) so it survives the process
that set it and any tool call in between. Only one session is tracked at a time;
running `start` again overwrites it.

## Field report: one real session, 2026-10-25

This repo exists because the script was written and used before it was versioned,
so the first entry here is a record of that use rather than a design note.

**The instruction.** Not "spend 30 minutes", which is a deadline. The phrasing
was a stop condition: use the timer, and if the work finishes before the 30
minutes are up, stop the timer and stop all work.

**What was run.** `start` once with a 30 minute budget, then `check` at three
points — after 11, 24, and 40 completed tasks. The checks were the gate for
"pick up another task", not a note taken at the end.

**What happened.** Work halted at roughly 22 minutes of the 30, on a tree that
typechecked, passed 238 tests across 34 files, deployed, and smoked clean. The
remaining queued items were agents-directory and demographic-filter features —
multi-file, several steps each — and they were left unstarted on purpose: they
could not have been finished in the remaining ~8 minutes, and starting them would
have left a half-applied change at the bell instead of a stopped-and-clean one.

The useful part is where the stop landed. The budget did not truncate work in
progress; it changed what got *started*. With ~8 minutes left the only honest
options are a change small enough to finish and verify, or nothing — and "nothing"
kept the tree shippable. Unused budget is the correct outcome of that decision,
not waste.

**Limits of the evidence.** One session, one operator, self-reported. It shows
the loop can be run this way and that an agent will obey an exit code it checks;
it does not show the habit survives a session that is going badly, or that 30
minutes is a good number. Those are open questions this repo is for.
