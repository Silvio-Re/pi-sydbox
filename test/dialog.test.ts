import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_DENY_MS, CHOICE_LABELS, choose, type UiPort } from "../src/dialog.ts";

/** Records what the dialog asked and answers with a canned reply. */
function fakeUi(answer: string | undefined, opts: { throwOnSelect?: boolean } = {}): UiPort & { seen: string[]; timeouts: (number | undefined)[] } {
  const seen: string[] = [];
  const timeouts: (number | undefined)[] = [];
  return {
    seen,
    timeouts,
    async select(prompt, labels, options) {
      seen.push(prompt);
      timeouts.push(options?.timeoutMs);
      assert.deepEqual(labels, CHOICE_LABELS);
      if (opts.throwOnSelect) throw new Error("ui went away");
      return answer;
    },
  };
}

test("every grant label maps onto its tier", async () => {
  const cases: [string, string][] = [
    ["Allow once", "once"],
    ["Allow for this session", "session"],
    ["Allow for this project", "project"],
    ["Allow always", "global"],
  ];
  for (const [label, tier] of cases) {
    const choice = await choose(fakeUi(label), "grant /etc/hosts?");
    assert.deepEqual(choice, { kind: "grant", tier });
  }
});

test("Deny, dismissal and an unknown label all reject", async () => {
  for (const answer of ["Deny", undefined, "something else"]) {
    assert.deepEqual(await choose(fakeUi(answer), "prompt"), { kind: "reject" });
  }
});

test("a dialog that throws denies instead of propagating", async () => {
  const ui = fakeUi("Allow always", { throwOnSelect: true });
  const notes: string[] = [];
  ui.notify = (m) => notes.push(m);
  assert.deepEqual(await choose(ui, "prompt"), { kind: "reject" });
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /denying/);
});

test("the timeout is the documented constant unless the caller overrides it", async () => {
  const withDefault = fakeUi("Deny");
  await choose(withDefault, "prompt");
  assert.deepEqual(withDefault.timeouts, [AUTO_DENY_MS]);

  const overridden = fakeUi("Deny");
  await choose(overridden, "prompt", { timeoutMs: 5_000 });
  assert.deepEqual(overridden.timeouts, [5_000]);
});

test("the prompt is passed through untouched", async () => {
  const ui = fakeUi("Deny");
  const prompt = "syd denied exec of /usr/bin/true (access/execve)\nAdd: allow/lpath,npath,rpath,exec+/usr/bin/true";
  await choose(ui, prompt);
  assert.deepEqual(ui.seen, [prompt]);
});
