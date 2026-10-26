# Prior art, and where this repo can be better

The field split into three kinds of tool: ones that **inform** the agent about time
(chronos, AgenticTime), ones that **stop** it (Docker Agent budgets, Overnight
Experimenter), and one that **measures** whether it obeyed (AgentTime, the paper).
Each is good at its own third. None closes the loop between them, and none answers
the question that actually decides a session's outcome: *should I start this now?*

What this repo has, as of 2026-10-25: 27 lines, no dependencies, a stop condition an
agent can check (`exit 2`), and one documented session where that changed what got
started rather than truncating work in flight. That is all. The purpose of this file
is to say precisely what to take from each project and what to build that none of
them have.

## 1. AgentTime — Ofengenden & Andriushchenko, arXiv 2610.09944 (Oct 2026)

The scientific one, and the standard to be judged against. A benchmark of 222 tasks
from 18 benchmark families, run in each agent's native CLI harness, asking three
questions: how long will this take you, how long did it take, and can you work for
N minutes.

**Method worth copying.** The prompt gets one appended instruction ("Please work on
this task for a full {N} {unit}") and nothing else — no resuming, no coaching. The
timer runs *outside* the sandbox, so the agent cannot see or alter the measurement,
and an administrative cutoff at 2× the largest request keeps a runaway from costing
forever while still recording it separately from a voluntary return. Three fresh runs
per task, one each at roughly 1×, 4× and 16× a base duration, so every task is faced
once with too little time and once with too much. 3,442 attempts, ~1,700 agent-hours,
~$93,000 at list prices.

**Findings that should shape the tool.**

| | Fable 5.1 (Claude Code) | GPT-5.6 Sol (Codex) | GPT-6 Astra (Codex) |
|---|---|---|---|
| On time (0.95–1.05×) | 4% | 39% | 63% |
| Early / late | 55% / 41% | 13% / 48% | 3% / 34% |
| Typical deviation | 2.86× | 1.77× | 1.18× |
| Slope, runtime vs request (ideal 1) | 0.59 | 0.71 | 0.94 |

- **The model matters more than the harness.** Swapping Fable into Codex and Astra
  into Claude Code moved slopes by 0.14–0.16; the model gap was 0.69–0.71.
- **On time is not the same as working.** Of 158 classifiable Astra runs, **14
  explicitly slept** after appearing to finish (9%) and 74 re-checked earlier work
  (47%). Of 49 on-time Astra agentic runs, only 11 met the "the result changed in the
  last fifth of the run" rule. Matching the clock is cheap; filling it is not.
- **More time rarely buys score.** The longest request was typically 16× the
  shortest and the native score was identical for 62–64% of tasks; it improved on
  only 23–25%.
- **Forecasts run high, the reverse of the human planning fallacy.** Median forecast
  was 15 minutes for all three models against median natural runtimes of 6–13
  minutes; typical misses of 3.8× (Sol), 2.9× (Astra), 2.6× (Fable).
- **Looking back is easy with cues, hard without.** Given an elapsed-time tool,
  retrospective estimates are near-exact; strip timestamps instead and Sol's typical
  miss goes 1.07× → 5.38×, Fable's and Astra's to ~2.6×.

**Where it stops.** It is an evaluation, not a control surface. It concludes agents
need to follow durations and be candid about how time was spent, and it leaves the
tooling question open. It also deliberately does not enforce: "the requested duration
is a user instruction, not a forced stopping time."

**The opening is exact.** They measured that agents *cannot* control runtime well.
Nobody has published whether giving an agent a checkable clock *improves* that. That
is a claim this repo can test on a laptop for the price of a few hours of tokens.

## 2. chronos — OthmanAdi/chronos

Time awareness for Claude Code, and the most mature thing in this space. It parses
the JSONL transcript the harness already writes, injects elapsed time into context
every turn, renders a statusline, detects retry loops by argument hash, warns when a
file changed after the agent last read it, and reports active time per session/day/
week. 53 tests, MIT, Node only — no daemon, no network, no dependencies.

**What it gets right, and we should steal outright.**

- **Active time, not wall clock.** Gaps over five minutes are idle. A resumed session
  has not been running for two days, and a tool that says otherwise is a tool you
  stop believing.
- **Push the number into context; do not wait to be asked.** It grounds this in
  arXiv 2510.23853: timestamps sit in context at <4% of reasoning traces and the best
  models reach only 65% alignment with human temporal judgment. A clock the model has
  to remember to look at is a clock it will not look at.
- **Loop detection on the argument hash**, not on the command name — the same failing
  command with the same arguments three times is the expensive failure mode in
  unattended work.
- **`doctor` that actually executes the hooks** against the newest real transcript,
  because the author's own v1 sat broken for nineteen days writing 10 MB of nothing.

**Where it stops.** It is awareness and monitoring. It has no notion of a budget the
work was supposed to fit into, no record of whether an estimate held, and no opinion
on whether to begin something. It tells you where the time went after it has gone.

**Note on scope, honestly.** It is Claude-Code-shaped: hooks, statusline, transcript
format. Our exit-code contract has to work in any harness that can run `node` and
read `$?`, which is a weaker but far wider guarantee.

## 3. Overnight Experimenter — dylanfeltus/overnight-experimenter

~1,000 lines of Python, zero dependencies: give it a program, an `evaluate.sh` that
prints a number, and `--budget 8h`, and it loops modify → score → keep or revert
until the budget dies, logging every trial to `experiments.jsonl` and snapshotting
the best version.

**What it gets right.** The budget bounds a *loop*, not a turn, and every unit of
work has a score attached, so "what did the time buy?" is answered by the log rather
than by memory. `best/` means the deadline cannot leave the tree worse than it
started.

**Where it stops.** It only works where a numeric metric exists and one modification
can be scored in isolation. It supplies the budget but never reasons about it: no
allocation across steps, no early-finish policy, no record of estimate vs actual, and
a budget that expires simply ends the loop.

## 4. AgenticTime — agentralabs/agentic-time

Temporal *planning*: deadlines, schedules with conflict detection, sequences with
dependencies, PERT duration estimates with confidence intervals, and four decay
models for information freshness, in a binary `.atime` file, exposed as 19 MCP tools
plus a Rust CLI and Python/Rust SDKs. 83 tests.

**What it gets right.** Tracking actuals against estimates is the feedback loop
almost nobody builds, and PERT with a confidence interval is the honest way to state
an estimate. Per-project isolation of timeline state is the right default.

**Where it stops, and why we should not follow.** This is organisational time —
Friday deadlines, Tuesday reviews — not runtime control. It has no enforcement of any
kind, no measurement of whether an agent adhered to a duration, and its heaviest
machinery (binary record format, memory-mapped I/O, LZ4, 0.02 ms deadline inserts)
optimises a problem nobody has: human-scale timelines are dozens of rows, not 10,000.
The install path is a `curl | bash` that merges into your editor configs. For a
session timer, all of that is attack surface and dependency weight for a file that
should be a few hundred bytes of JSON.

## 5. Docker Agent budgets

The best-engineered *enforcement* model, and worth reading closely even though it
lives in one product. `budget: {max_cost, max_tokens, max_time}` per run or per named
pot; the first limit to bind stops the run; a stopped run produces a
`budget_exceeded` event carrying `budget`, `limit`, `used`, `max`, `config_path` and
is distinguishable from success in telemetry; the TUI gauges consumption live.

**Two design decisions to copy.**

- **`max_time` measures working time — the sum of turn durations — not wall clock.**
  Their reasoning is decisive: a wall-clock budget expires while you are at lunch and
  takes the agent with it. This is the same insight as chronos's "active time", from
  the enforcement side.
- **A stop is terminal and structured.** No dialog offering to continue, an event
  naming the exact config path and the used/max pair, a distinct stream-end reason.

**Where it stops.** It is a ceiling, checked at turn boundaries, so a run overshoots
by up to one turn (they say so and tell you to leave headroom). It knows what was
spent, never what was planned, and it cannot tell whether the last hour bought
anything. Same for Feiyu Agent's time budget, which additionally nudges the model to
wrap up as the deadline nears: instruction shaping, not measurement.

## The capability grid

| | Measures adherence | Enforces a stop | Forecasts vs actual | Gates *starting* work | Zero install | Harness-agnostic |
|---|---|---|---|---|---|---|
| AgentTime | ★ (offline) | — (deliberately not) | ★ | — | — | — (native CLIs) |
| chronos | ★ (active time) | — | — | — | ★ | — |
| Overnight Experimenter | — | ★ (loop) | — | — | ~ (Python) | ★ |
| AgenticTime | ~ (tracks actuals) | — | ★ (PERT) | — | — | ★ |
| Docker Agent | ~ (spend only) | ★ (turn boundary) | — | — | — | — |
| **time (now)** | — | ~ (advisory) | — | — | ★ | ★ |
| **time (target)** | ★ | ★ (supervised) | ★ | ★ | ★ | ★ |

Read the last two rows as the thesis: everyone else has two or three of these
columns. The one nobody has is **gates starting work**, and it is the one that
decides whether a session ends clean.

## What to build, in order

Each item is small enough to finish and verify in one sitting, which is the only size
this repo should ever ship.

1. **`check --needs 8m` — the start gate.** Exit 0 only if the remaining budget covers
   a task of that size, with a reserve for verification. This is the decision that
   was actually being made by hand on 2026-10-25 when four multi-file features were
   correctly left unstarted. No other tool in this list expresses it.
2. **An append-only ledger.** `plan <label> --estimate 12m`, `start`, `done`, plus one
   JSONL record per event. Gives estimate-vs-actual per task class (AgentTime's
   forecasting arm, per-session), a resumable history across sessions, and something
   to compute against instead of a single mutable state file.
3. **Working time, not wall clock, on by default — with wall clock available.** Copy
   Docker's reasoning and chronos's idle rule: sum of measured work intervals, gaps
   over N minutes excluded, `--wall-clock` escape hatch for "stop at 6pm".
4. **A structured stop.** On expiry write a handoff record — what was in flight, what
   is next, what was verified — and exit with a *distinct* code for "budget spent
   cleanly" versus "overran". A stop the next session can read is worth more than a
   stop that is merely loud.
5. **`verify`.** Recompute elapsed time from the append-only ledger and refuse a
   result that contradicts it, so the gate is checkable rather than trusted. Name the
   limitation plainly: an agent that can write the state file can lie to itself; only
   a supervisor outside the process can prevent that, and `verify` is what a
   supervisor would run.
6. **The experiment this repo exists for.** A `bench/` that replays AgentTime's
   duration-following protocol on a handful of tasks — one instruction, three
   durations at 1×/4×/16×, an external supervisor timer, no coaching — run twice, with
   and without `check` gating. Score on-time %, deviation factor, slope, and the
   binary that matters to us: **did the gated agent start work it could not finish?**
   Their rig cost $93k and two labs. Ours can be an afternoon and a handful of runs,
   which is enough for a directional claim and enough to keep us honest.

Two things to keep from the current 27 lines: the exit code is `2`, not `1`, so a
budget stop can never be mistaken for a crash; and there is exactly one state file,
so a session either has a budget or does not.

## Two cautions recorded now, so they are not discovered later

- **The gate is advisory.** Nothing in a 27-line script stops an agent from ignoring
  `exit 2`, editing the state file, or starting `start` again with a fresh 30 minutes.
  The 2026-10-25 session is evidence that an agent *will* obey, not that it *must*.
  Any claim of enforcement needs the supervisor from item 6.
- **A clock that answers "when will I be stopped" is also a probe.** AgentTime cites
  a public investigation of agents using heartbeats to infer when runs would end
  (Von Arx et al., 2026), and treats temporal self-control as dual-use. Logging every
  check, with a timestamp and a caller, is both the safety answer and the data we
  need for item 6.

## Sources

- Ofengenden & Andriushchenko, *AgentTime: Can Agents Estimate and Control Their Own
  Runtime?*, arXiv 2610.09944 (v2, 8 Oct 2026) — <https://arxiv.org/abs/2610.09944>.
  Code and run data: <https://github.com/michaelofengenden/agenttimebench>,
  <https://agenttimebench.com>.
- OthmanAdi, *chronos* — <https://github.com/OthmanAdi/chronos>. Its grounding paper:
  Cheng et al., *Your LLM Agents are Temporally Blind*, arXiv 2510.23853.
- dylanfeltus, *overnight-experimenter* —
  <https://github.com/dylanfeltus/overnight-experimenter>.
- agentralabs, *agentic-time* — <https://github.com/agentralabs/agentic-time>.
- Docker, *Budget* — <https://docs.docker.com/ai/docker-agent/configuration/budget/>.
- Von Arx et al. (2026), as cited in AgentTime §1 on heartbeat probing.

Numbers above are quoted from the paper's Tables 3 and its figures; anything about
this repo's own behavior is from the single session in `README.md`, n=1.
