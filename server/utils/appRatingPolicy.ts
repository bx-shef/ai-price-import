// Pure decision core for the in-portal «оцените приложение» prompt (no I/O → unit-tested).
// State lives in portal_app_rating (one row per portal). The rules mirror the owner's spec:
//   • reviewed === true  → NEVER prompt again (a real Market review is confirmed).
//   • opened_at is set   → the user already clicked «Оценить»; suppress until an owner MANUALLY
//                          verifies the review. If none appeared after ~RATING_REPROMPT_DAYS the
//                          owner clears opened_at and the prompt returns (see appRatingStore).
//   • otherwise          → show, but no more than once per RATING_REPROMPT_DAYS (throttled by
//                          prompted_at). So it surfaces «раз в несколько дней», never on every open.

/** Days between prompts and the manual-verification window. Kept as one constant so the throttle
 *  and the «через N дней проверяем руками» window stay in lockstep. */
export const RATING_REPROMPT_DAYS = 4

/**
 * Minimum age of the INSTALLATION before the first prompt (#380).
 *
 * Nothing delayed the first ask: a portal that installed the app and ran one successful import ten
 * minutes later was already asked to rate it. That is early — the person has seen the product once
 * — and there is barely a second chance: clicking «Оценить» stamps `opened_at` and the prompt goes
 * silent until the owner verifies by hand.
 *
 * ⚠ A SEPARATE constant from `RATING_REPROMPT_DAYS`, even though both are 4 today. They mean
 * different things — «не чаще раза в N дней» and «не раньше N суток от установки» — and one
 * constant for two meanings binds them forever; the coincidence is accidental.
 */
export const RATING_MIN_INSTALL_AGE_DAYS = 4

const DAY_MS = 24 * 60 * 60 * 1000

/** Row shape from portal_app_rating (nulls when the portal has no row yet). */
export interface AppRatingState {
  promptedAt: Date | null
  openedAt: Date | null
  reviewed: boolean
}

export interface ShouldPromptOptions {
  /** Override the re-prompt interval (days). Defaults to RATING_REPROMPT_DAYS. */
  repromptDays?: number
  /** Override the minimum install age (days). Defaults to RATING_MIN_INSTALL_AGE_DAYS. */
  minInstallAgeDays?: number
}

/**
 * Decide whether to show the rating modal now. `now` is injected so the decision is deterministic
 * and testable. A missing row (never prompted) → show.
 */
export function shouldPrompt(
  state: AppRatingState | null,
  now: Date,
  opts: ShouldPromptOptions = {},
  installedAt?: Date | null
): boolean {
  // Install age gates EVERYTHING, including the first-ever prompt (#380).
  //
  // ⚠ Unknown age reads as «too early», not «go ahead»: the token row can be missing during an
  // install race or after a purge, and the cost is asymmetric — an early prompt burns the single
  // attempt we get, while a late one costs a few days.
  //
  // ⚠ Re-installation restarts the clock by construction: uninstall deletes the `portal_tokens`
  // row, so `created_at` begins anew. That is a CHOICE, not an accident — a returning portal is
  // meeting the product again, and asking it to rate on day one would be the same mistake.
  const ageDays = opts.minInstallAgeDays ?? RATING_MIN_INSTALL_AGE_DAYS
  if (!installedAt) return true
  if (now.getTime() - installedAt.getTime() < ageDays * DAY_MS) return false
  if (!state) return true // old enough and no row yet → first-ever prompt
  if (state.reviewed) return false // confirmed review → silent (the operator can undo it, #318 п.2)
  if (state.openedAt) return false // clicked «Оценить» → wait for manual verification
  if (!state.promptedAt) return true // row exists but never actually shown
  const intervalMs = (opts.repromptDays ?? RATING_REPROMPT_DAYS) * DAY_MS
  return now.getTime() - state.promptedAt.getTime() >= intervalMs
}
