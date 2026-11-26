import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLocalBashOperations,
  VERSION,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionUIDialogOptions,
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
  type UserBashEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * pi host-contract checks (roadmap P2). The three contract points the
 * extension depends on:
 *   1. createLocalBashOperations is exported and callable (powers user_bash),
 *   2. the extension UI dialog options accept `timeout` (not `timeoutMs`),
 *   3. the events tool_call, tool_result and user_bash exist in the API
 *      surface.
 * Points whose surface is runtime (1) are asserted at runtime here; points
 * whose surface is types (2, 3) are asserted type-level: `npm run typecheck`
 * (inside `npm run ci`) must fail if the declarations below stop compiling.
 * The test only imports the package; it never launches pi.
 *
 * The package itself is the exactly-pinned devDependency
 * `@earendil-works/pi-coding-agent@1.6.0` (package.json), so this file checks
 * the real shipped surface, not a local twin of it.
 */

test("the pinned pi package reports version 1.6.0", () => {
  assert.equal(VERSION, "1.6.0");
});

test("createLocalBashOperations is an exported callable", () => {
  assert.equal(typeof createLocalBashOperations, "function");
});

// --- Type-level assertions (fail via tsc inside `npm run ci`) ---------------

/** Fails to compile unless the dialog options still accept `timeout`. */
type DialogTimeoutAccepted = ExtensionUIDialogOptions extends { timeout?: number } ? true : never;
const dialogTimeoutAccepted: DialogTimeoutAccepted = true;

/** Fails to compile if the historical `timeoutMs` misspelling comes back. */
type LegacyTimeoutMsRejected = "timeoutMs" extends keyof ExtensionUIDialogOptions ? never : true;
const legacyTimeoutMsRejected: LegacyTimeoutMsRejected = true;

/** Fails to compile unless the event payloads keep their literal `type`s. */
type ToolCallIsToolCall = ToolCallEvent["type"] extends "tool_call" ? true : never;
const toolCallIsToolCall: ToolCallIsToolCall = true;
type ToolResultIsToolResult = ToolResultEvent["type"] extends "tool_result" ? true : never;
const toolResultIsToolResult: ToolResultIsToolResult = true;
type UserBashIsUserBash = UserBashEvent["type"] extends "user_bash" ? true : never;
const userBashIsUserBash: UserBashIsUserBash = true;

// Registering handlers for the three events only typechecks while the API
// surface accepts these event names and these handler shapes. The functions
// are never invoked.
const registersToolCall: (api: ExtensionAPI) => void = (api) => {
  api.on("tool_call", () => undefined);
};
const registersToolResult: (api: ExtensionAPI) => void = (api) => {
  api.on("tool_result", () => undefined);
};
const registersUserBash: (api: ExtensionAPI) => void = (api) => {
  api.on("user_bash", () => undefined);
};

// --- P3 additions: the surfaces the clone-to-usable order depends on -------

/** A tool_result handler may return a modified result (the transform contract). */
const transformsBashResult: (api: ExtensionAPI) => void = (api) => {
  api.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
    const explainer: ToolResultEventResult = { content: [...event.content, { type: "text", text: "denied" }] };
    return event.isError ? explainer : undefined;
  });
};

/** before_agent_start exposes the mutable system-prompt options. */
const appendsPromptGuidelines: (api: ExtensionAPI) => void = (api) => {
  api.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    event.systemPromptOptions.promptGuidelines.push("a guideline");
  });
};

/** registerCommand adds a slash command whose handler receives its arguments. */
const registersSlashCommand: (api: ExtensionAPI) => void = (api) => {
  api.registerCommand("sydbox", {
    description: "pi-sydbox sandbox",
    handler: async (args: string) => { void args; },
  });
};

test("the type-level contract assertions hold", () => {
  assert.ok(dialogTimeoutAccepted);
  assert.ok(legacyTimeoutMsRejected);
  assert.ok(toolCallIsToolCall);
  assert.ok(toolResultIsToolResult);
  assert.ok(userBashIsUserBash);
  assert.ok(typeof registersToolCall === "function");
  assert.ok(typeof registersToolResult === "function");
  assert.ok(typeof registersUserBash === "function");
  assert.ok(typeof transformsBashResult === "function", "the tool_result transform contract exists in 1.6.0");
  assert.ok(typeof appendsPromptGuidelines === "function", "before_agent_start exposes promptGuidelines in 1.6.0");
  assert.ok(typeof registersSlashCommand === "function", "registerCommand exists in 1.6.0");
});
