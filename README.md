# time

A wall-clock budget for a work session, as a single dependency-free Node script.

It exists because "work for 30 minutes" needs to be a thing an agent (or a shell)
can *check*, not a thing it remembers: `check` exits non-zero the moment the
budget is spent, so anything that runs after it can be gated on the result.

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

## Contract

| command | writes | exit code |
| --- | --- | --- |
| `start` | state file with start time + budget | `0` |
| `check` | nothing | `0` while running, `2` once expired |

`check` exits `2`, not `1`, so it can't be mistaken for a crash. The shell idiom
is `node time.mjs check || <stop work>`, and inside a script on `set -e` the
non-zero exit halts it.

## Environment

- `MINUTES` — budget length, default `30`.
- `TIMER_STATE` — state file path, default `/tmp/time-timer.json`.

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
