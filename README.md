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
