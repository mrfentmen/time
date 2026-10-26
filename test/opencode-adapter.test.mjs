// The opencode adapter exists so E4 can be run on a second harness. Its command
// line is the only part that differs from the codex adapter, so that is what is
// pinned here: prompt as an argument, permissions auto-approved (the bench runs in a
// throwaway directory), and the model explicit in every call so a result file can
// say what produced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, defaultModel } from "../bench/adapters/opencode.mjs";

test("the prompt is an argument, and the run is unattended", () => {
  const args = buildArgs({ prompt: "do the thing", model: "opencode/x" });
  assert.deepEqual(args, ["run", "--auto", "--model", "opencode/x", "do the thing"]);
});

test("a prompt that looks like a flag is still data", () => {
  const args = buildArgs({ prompt: "--help", model: "opencode/x" });
  assert.equal(args.at(-1), "--help");
  assert.equal(args.indexOf("--auto"), 1, "flags come before the message");
});

test("there is a default model, so a run cannot silently pick another", () => {
  assert.match(defaultModel, /^opencode\//);
});
