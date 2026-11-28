import { safeErrorMessage } from './scheduler.ts';

/**
 * Start-up steps of this process that failed (a module's lifecycle.start, starting the background
 * jobs). main.ts records them; /readyz answers 503 "not_ready" with the failed steps while any is
 * recorded, instead of "ready" for an API that is only partly running. The desktop engine restarts
 * the API after three 503s in a row, which retries the failed step.
 */
export interface StartupFailure {
  step: string;
  at: string;
  message: string;
}

const failures: StartupFailure[] = [];

export function recordStartupFailure(step: string, err: unknown): void {
  failures.push({ step, at: new Date().toISOString(), message: safeErrorMessage(err) });
}

export function startupFailures(): readonly StartupFailure[] {
  return failures;
}

/** Tests only. */
export function clearStartupFailures(): void {
  failures.length = 0;
}
