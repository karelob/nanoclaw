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

// "<id><kind>[c][ <comment>]" — kind ∈ u|n|d|w; optional 'c' = needs more
// long-term context. 'c' is only meaningful with 'u' or 'w' (when the
// insight was directionally OK or wrong but more context would help).
// 'nc' / 'dc' are rejected — context can't salvage noise/duplicates.
const FEEDBACK_PATTERN = /^(\d+)([undw])(c?)(?:\s+(.+))?$/;

const KIND_MAP: Record<string, string> = {
  u: 'useful',
  n: 'noise',
  d: 'duplicate',
  w: 'wrong',
};

// Which kinds may carry the 'c' (needs context) modifier.
const CONTEXT_ALLOWED = new Set(['u', 'w']);

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
  const needsContext = match[3] === 'c';
  const comment = match[4]?.trim() || null;
  const kind = KIND_MAP[kindShort];

  if (needsContext && !CONTEXT_ALLOWED.has(kindShort)) {
    return {
      reply: `'${kindShort}c' nedává smysl — \`c\` (needs context) jen s \`u\` nebo \`w\``,
    };
  }

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
      .prepare(
        'SELECT id, type, headline_cs, feedback_kind FROM insights WHERE id = ?',
      )
      .get(insightId) as
      | {
          id: number;
          type: string;
          headline_cs: string;
          feedback_kind: string | null;
        }
      | undefined;

    if (!row) {
      return { reply: `insight #${insightId} neexistuje` };
    }

    db.prepare(
      `UPDATE insights
         SET feedback_kind = ?,
             feedback_note = ?,
             feedback_at = ?,
             feedback_needs_context = ?,
             status = 'shown'
         WHERE id = ?`,
    ).run(
      kind,
      comment,
      new Date().toISOString(),
      needsContext ? 1 : 0,
      insightId,
    );

    logger.info(
      {
        insightId,
        kind,
        needsContext,
        hasNote: !!comment,
        prev: row.feedback_kind,
      },
      'insight feedback recorded',
    );

    const ctxTag = needsContext ? ' +context' : '';
    // Negative needs a comment for tuning; needs-context also ideally a comment.
    const isNegative = kind !== 'useful';
    if ((isNegative || needsContext) && !comment) {
      const askFor = needsContext
        ? 'jaký širší kontext bys čekal'
        : 'důvod';
      return {
        reply: `${kind}${ctxTag} (#${insightId}) — díky. Pokud chceš detail (${askFor}): \`${insightId}${kindShort}${needsContext ? 'c' : ''} <text>\``,
      };
    }
    return { reply: `${kind}${ctxTag} (#${insightId}) ✓` };
  } finally {
    db.close();
  }
}
