/**
 * Approval dialog state machine over ctx.ui (phase 2).
 *
 * The state machine is pure and takes a UI port, so the decision logic is
 * testable without a terminal. `pi/index.ts` adapts pi's `ctx.ui` onto that port.
 *
 * Open number: the auto-deny delay. It is now MEASURED (P0, 2026-11-25):
 * pi-coding-agent 1.6.0 honors the dialog `timeout` option and auto-resolves
 * an unanswered select 120 070 ms after the request when 120 000 is sent
 * (headless RPC probe, evidence committed under docs/evidence/p0-auto-deny-20261125/).
 * The value stays a documented constant here rather than a hidden default,
 * and callers may override it per launch.
 *
 * The prompt budget lives here as a constant the caller enforces per tool
 * result: past the budget the remaining denials stay denied with a count
 * notification, because a 30-denial batch must not hold the session hostage
 * at AUTO_DENY_MS per prompt. Re-prompting a path the user already granted
 * is the caller's dedupe, not this module's.
 */

export interface DialogChoice {
  kind: "grant" | "reject";
  tier?: "once" | "session" | "project" | "global";
}

export const TIERS = ["once", "session", "project", "global"] as const;
export type Tier = (typeof TIERS)[number];

/** Measured (P0, 2026-11-25): pi-coding-agent 1.6.0 honors the dialog
 * `timeout` option; an unanswered deny prompt auto-resolves 70 ms past this
 * value in a headless RPC probe (docs/evidence/p0-auto-deny-20261125/). Override per
 * call. */
export const AUTO_DENY_MS = 120_000;

/** Prompts asked per tool result; further denials stay denied with a notice. */
export const PROMPT_BUDGET = 4;

/** The labels a user picks between, in order. Reject is always last. */
export const CHOICE_LABELS = [
  "Allow once",
  "Allow for this session",
  "Allow for this project",
  "Allow always",
  "Deny",
] as const;

export type ChoiceLabel = (typeof CHOICE_LABELS)[number];

const LABEL_TIER: Readonly<Record<ChoiceLabel, Tier | null>> = Object.freeze({
  "Allow once": "once",
  "Allow for this session": "session",
  "Allow for this project": "project",
  "Allow always": "global",
  Deny: null,
});

/** The slice of `ctx.ui` this module needs; pi's real context satisfies it. */
export interface UiPort {
  select(prompt: string, labels: readonly string[], opts?: { timeout?: number }): Promise<string | undefined>;
  notify?(message: string): void;
}

export interface ChooseOptions {
  /** Auto-deny delay for this prompt, in ms. Defaults to AUTO_DENY_MS.
   * The key pi expects on its dialog API is `timeout` (pi-coding-agent 1.6.0,
   * `ExtensionUIDialogOptions`, its docs/rpc-extension-ui.md): sending the old
   * `timeoutMs` was silently ignored by every mode, so an unanswered prompt
   * blocked forever instead of auto-denying (P0 — the fix, and the reason
   * AUTO_DENY_MS used to be dead config). */
  timeout?: number;
}

/**
 * Asks the user what to do with one violation.
 *
 * Anything that is not a recognised grant label — a dismissed prompt, a timeout,
 * an unexpected string — is a reject. Rejecting is the only safe default, so this
 * function never throws and never returns a grant it did not see chosen.
 */
export async function choose(
  ui: UiPort,
  prompt: string,
  options: ChooseOptions = {},
): Promise<DialogChoice> {
  const timeout = options.timeout ?? AUTO_DENY_MS;
  let answer: string | undefined;
  try {
    answer = await ui.select(prompt, CHOICE_LABELS, { timeout });
  } catch (err) {
    ui.notify?.(`approval dialog failed, denying: ${(err as Error).message}`);
    return { kind: "reject" };
  }

  if (answer === undefined) return { kind: "reject" };
  const tier = LABEL_TIER[answer as ChoiceLabel];
  if (tier === undefined) return { kind: "reject" };
  if (tier === null) return { kind: "reject" };
  return { kind: "grant", tier };
}
