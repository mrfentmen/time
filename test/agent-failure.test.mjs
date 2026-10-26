// The guard that stops an instrument failure from being scored as behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentFailure, assertAgentSucceeded } from "../lib/agent.mjs";

test("a clean exit passes", () => {
  assert.doesNotThrow(() => assertAgentSucceeded({ code: 0, agentOutput: "ok" }));
});

test("a supervisor kill is a measurement, not a failure", () => {
  assert.doesNotThrow(() => assertAgentSucceeded({ code: null, killed: true }));
});

test("a failed invocation names the reason it failed", () => {
  assert.throws(
    () =>
      assertAgentSucceeded({
        code: 1,
        agentOutput: "Error: Free usage limit reached. Free models work in OpenCode",
      }),
    (error) => {
      assert.ok(error instanceof AgentFailure, "a distinct type so the runner can exit 65");
      assert.match(error.message, /agent exited 1/);
      assert.match(error.message, /Free usage limit reached/);
      return true;
    },
  );
});

test("a failure with no output still fails, and says so", () => {
  assert.throws(() => assertAgentSucceeded({ code: 1 }), /with no output/);
});
