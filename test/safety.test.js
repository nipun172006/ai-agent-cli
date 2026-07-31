import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertSafeCommand, resolveInsideWorkspace } from "../index.js";

test("allows the documented project-local directory command", () => {
  assert.doesNotThrow(() => assertSafeCommand("mkdir -p scaler-academy-clone"));
});

test("blocks common destructive and privileged commands", () => {
  assert.throws(() => assertSafeCommand("rm -rf generated-site"), /rejected/i);
  assert.throws(() => assertSafeCommand("sudo npm install"), /rejected/i);
  assert.throws(() => assertSafeCommand("git reset --hard"), /rejected/i);
});

test("rejects file paths outside the project", () => {
  assert.throws(() => resolveInsideWorkspace("../outside.txt"), /escapes/i);
  assert.throws(() => resolveInsideWorkspace(path.parse(process.cwd()).root), /relative/i);
});
