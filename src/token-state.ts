/**
 * Dual OAuth token state management.
 *
 * Evolution Enterprise token is the primary key for Burlak and Šiška.
 * Personal Max token is the fallback when Evolution is exhausted or errors.
 *
 * State persists to disk so fallback survives restarts and we don't hammer
 * a failed Evolution token on every container start.
 *
 * NanoClaw CLI (interactive sessions) always uses the personal Max key — this
 * module is NOT used by the main NanoClaw process itself.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export type TokenChoice = 'evolution' | 'personal';

interface TokenState {
  activeToken: TokenChoice;
  evolutionFailedAt?: number; // Unix ms timestamp
  evolutionResetAt?: number; // Unix ms — when to retry Evolution
  evolutionFailReason?: string;
  lastUpdated: number;
}

/** Default retry interval — check Evolution again after 24h. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function getStateFile(): string {
  return path.join(os.homedir(), '.config', 'nanoclaw', 'token_state.json');
}

function readState(): TokenState {
  try {
    const content = fs.readFileSync(getStateFile(), 'utf-8');
    return JSON.parse(content) as TokenState;
  } catch {
    return { activeToken: 'evolution', lastUpdated: Date.now() };
  }
}

function writeState(state: TokenState): void {
  const file = getStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/**
 * Returns true if Evolution token should be used (primary).
 * Returns false if personal Max token should be used (fallback).
 *
 * If the Evolution retry window has passed, automatically resets state back
 * to Evolution so the next run picks it up again.
 */
export function shouldUseEvolution(): boolean {
  const state = readState();
  if (state.activeToken === 'evolution') return true;

  // Check if the retry window has expired
  if (state.evolutionResetAt && Date.now() >= state.evolutionResetAt) {
    logger.info(
      { retryAt: new Date(state.evolutionResetAt).toISOString() },
      'Evolution token retry window passed — resetting to Evolution',
    );
    writeState({ activeToken: 'evolution', lastUpdated: Date.now() });
    return true;
  }

  return false;
}

/**
 * Mark Evolution token as failed and switch to personal Max fallback.
 *
 * @param reason - Human-readable failure reason (included in logs)
 * @param retryAfterMs - How long until Evolution should be tried again.
 *   Pass the value from a Retry-After header if available; otherwise defaults
 *   to RETRY_AFTER_MS (24h).
 */
export function markEvolutionFailed(
  reason: string,
  retryAfterMs?: number,
): void {
  const state = readState();
  // Already on personal — just extend the reset time if provided
  if (state.activeToken === 'personal' && !retryAfterMs) return;

  const retryMs = retryAfterMs ?? RETRY_AFTER_MS;
  const resetAt = Date.now() + retryMs;
  writeState({
    activeToken: 'personal',
    evolutionFailedAt: Date.now(),
    evolutionResetAt: resetAt,
    evolutionFailReason: reason,
    lastUpdated: Date.now(),
  });
  logger.warn(
    {
      reason,
      retryAt: new Date(resetAt).toISOString(),
      retryAfterMs: retryMs,
    },
    'Evolution OAuth token failed — switched to personal Max token',
  );
}

/**
 * Mark Evolution token as working — clear any failure state.
 * Called after a successful OAuth exchange using the Evolution token.
 */
export function markEvolutionOk(): void {
  const state = readState();
  if (state.activeToken === 'personal') {
    writeState({ activeToken: 'evolution', lastUpdated: Date.now() });
    logger.info(
      'Evolution OAuth token working — restored from personal fallback',
    );
  }
}

/** Human-readable summary of current token state for logging. */
export function getTokenStateSummary(): string {
  const state = readState();
  if (state.activeToken === 'evolution') return 'evolution (primary)';
  const resetAt = state.evolutionResetAt
    ? ` until ${new Date(state.evolutionResetAt).toISOString()}`
    : '';
  return `personal (fallback${resetAt}; reason: ${state.evolutionFailReason ?? 'unknown'})`;
}

/**
 * Parse a Retry-After header value (seconds integer or HTTP date string)
 * and return the equivalent milliseconds, capped at 7 days.
 */
export function parseRetryAfterMs(
  header: string | undefined,
): number | undefined {
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 7 * 24 * 60 * 60 * 1000);
  }
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? Math.min(ms, 7 * 24 * 60 * 60 * 1000) : undefined;
  }
  return undefined;
}
