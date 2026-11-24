/**
 * Approval dialog state machine over ctx.ui (phase 2).
 *
 * The state machine is pure and takes a UI port, so the decision logic is
 * testable without a terminal. `pi/index.ts` adapts pi's `ctx.ui` onto that port.
 *
 * Open number: the auto-deny delay. It should derive from the measured pi-web RPC
 * timeout (phase 0 step 5), which was never measured; a wrong value only changes
 * how long an unanswered prompt stays on screen, so it is a documented constant
 * here rather than a hidden default, and callers may override it per launch.
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

/** PROVISIONAL until phase-0 step 5 is measured on pi-web. Override per call. */
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
  select(prompt: string, labels: readonly string[], opts?: { timeoutMs?: number }): Promise<string | undefined>;
  notify?(message: string): void;
}

export interface ChooseOptions {
  /** Auto-deny delay for this prompt. Defaults to AUTO_DENY_MS. */
  timeoutMs?: number;
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
  const timeoutMs = options.timeoutMs ?? AUTO_DENY_MS;
  let answer: string | undefined;
  try {
    answer = await ui.select(prompt, CHOICE_LABELS, { timeoutMs });
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
