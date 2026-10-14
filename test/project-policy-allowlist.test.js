// Every check command in the repo policy must be on its own command allowlist (live defect 2026-10-14: round 5 added
// docs-check / run-if-changed checks without allowlisting them, so every docs task stopped at awaiting_approval).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync(new URL("../.ai/project.json", import.meta.url), "utf8"));
const allow = policy.allowlists.commands;
const commands = [];
(function walk(v) {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === "object") {
    if (Array.isArray(v.command) && v.command.every((a) => typeof a === "string")) commands.push(v.command);
    Object.entries(v).forEach(([k, x]) => k !== "allowlists" && walk(x));
  }
})(policy);

test("policy declares check commands", () => assert.ok(commands.length > 0));
for (const cmd of commands) {
  test(`check command is allowlisted: ${cmd.join(" ")}`, () => {
    assert.ok(allow.some((a) => a.every((x, i) => cmd[i] === x)), `not allowlisted: ${JSON.stringify(cmd)}`);
  });
}
