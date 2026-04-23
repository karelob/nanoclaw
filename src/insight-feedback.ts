/**
 * Insight feedback handler — Phase 3 reasoning loop eval channel.
 *
 * Karel marks insights via Telegram with a compact pattern:
 *   "7u"             → insight 7, useful
 *   "7n"             → noise
 *   "7d"             → duplicate
 *   "7w some reason" → wrong, with optional comment
 *
 * Per knowledge/plans/phase3_reasoning_loop.md §6.
 *
 * Writes to ~/Develop/nano-cone/cone/db/insights.db (host SQLite, accessible
 * from the nanoclaw daemon — no container mount needed). The handler returns
 * the reply text the channel should send back, or null if the message wasn't
 * a feedback command.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const INSIGHTS_DB_PATH = path.join(
  os.homedir(),
  'Develop/nano-cone/cone/db/insights.db',
);

// "<id><kind>[ <comment>]" — kind ∈ u|n|d|w
const FEEDBACK_PATTERN = /^(\d+)([undw])(?:\s+(.+))?$/;

const KIND_MAP: Record<string, string> = {
  u: 'useful',
  n: 'noise',
  d: 'duplicate',
  w: 'wrong',
};

export interface InsightFeedbackResult {
  reply: string;
}

/**
 * Try to handle an incoming Telegram message as insight feedback.
 * Returns null if the message doesn't match the pattern; otherwise applies
 * the feedback and returns the reply text to send back.
 */
export function tryHandleInsightFeedback(
  rawText: string,
): InsightFeedbackResult | null {
  const text = rawText.trim();
  const match = FEEDBACK_PATTERN.exec(text);
  if (!match) return null;

  const insightId = parseInt(match[1], 10);
  const kindShort = match[2];
  const comment = match[3]?.trim() || null;
  const kind = KIND_MAP[kindShort];

  if (!fs.existsSync(INSIGHTS_DB_PATH)) {
    logger.warn(
      { dbPath: INSIGHTS_DB_PATH },
      'insight feedback: insights.db not found',
    );
    return { reply: `insights.db nedostupná` };
  }

  const db = new Database(INSIGHTS_DB_PATH, { fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT id, type, headline_cs, feedback_kind FROM insights WHERE id = ?')
      .get(insightId) as
      | { id: number; type: string; headline_cs: string; feedback_kind: string | null }
      | undefined;

    if (!row) {
      return { reply: `insight #${insightId} neexistuje` };
    }

    db.prepare(
      `UPDATE insights
         SET feedback_kind = ?, feedback_note = ?, feedback_at = ?, status = 'shown'
         WHERE id = ?`,
    ).run(kind, comment, new Date().toISOString(), insightId);

    logger.info(
      { insightId, kind, hasNote: !!comment, prev: row.feedback_kind },
      'insight feedback recorded',
    );

    // Reply nudge: ask for a comment when negative feedback came without one.
    const isNegative = kind !== 'useful';
    if (isNegative && !comment) {
      return {
        reply: `${kind} (#${insightId}) — díky. Pokud chceš detail proč: \`${insightId}${kindShort} <důvod>\``,
      };
    }
    return { reply: `${kind} (#${insightId}) ✓` };
  } finally {
    db.close();
  }
}
