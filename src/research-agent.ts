/**
 * Research Agent — proactive self-improvement through external research.
 *
 * Runs 2-3x daily from NanoClaw host process (no container needed).
 * Fetches external sources, analyzes with Gemini, writes proposals.
 *
 * Sources:
 *   - Moltbook feed (API)
 *   - AI blogs and changelogs (web fetch)
 *   - Dependency updates (npm, pip)
 *
 * Output: knowledge/topics/agent_proposals/YYYY-MM-DD-research.md
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { KNOWLEDGE_REPO_PATH } from './config.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const envVars = readEnvFile(['GOOGLE_AI_API_KEY', 'MOLTBOOK_API_KEY']);

const GEMINI_KEY = process.env.GOOGLE_AI_API_KEY || envVars.GOOGLE_AI_API_KEY;
const MOLTBOOK_KEY = process.env.MOLTBOOK_API_KEY || envVars.MOLTBOOK_API_KEY;

const PROPOSALS_DIR = path.join(
  KNOWLEDGE_REPO_PATH,
  'topics',
  'agent_proposals',
);

// ── Data fetchers ───────────────────────────────────

function fetchUrl(url: string, timeoutSec = 15): string | null {
  try {
    return execFileSync(
      '/usr/bin/curl',
      [
        '-s',
        '-L',
        '--connect-timeout',
        '10',
        '--max-time',
        String(timeoutSec),
        url,
      ],
      { timeout: (timeoutSec + 5) * 1000, encoding: 'utf8' },
    );
  } catch {
    return null;
  }
}

function fetchMoltbookFeed(limit = 10): string[] {
  if (!MOLTBOOK_KEY) return [];
  try {
    const raw = execFileSync(
      '/usr/bin/curl',
      [
        '-s',
        '--connect-timeout',
        '10',
        '--max-time',
        '15',
        '-H',
        `Authorization: Bearer ${MOLTBOOK_KEY}`,
        `https://www.moltbook.com/api/v1/feed?limit=${limit}`,
      ],
      { timeout: 20_000, encoding: 'utf8' },
    );
    const data = JSON.parse(raw);
    return (data.posts || []).map(
      (p: {
        title?: string;
        content?: string;
        comment_count?: number;
        id?: string;
      }) =>
        `[${p.comment_count || 0}💬] ${p.title || '?'}\n${(p.content || '').slice(0, 300)}`,
    );
  } catch (err) {
    logger.warn({ err }, 'Research: Moltbook fetch failed');
    return [];
  }
}

function fetchBlog(url: string): string | null {
  const html = fetchUrl(url, 20);
  if (!html) return null;
  // Strip HTML to text
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 5000);
}

function readCurrentState(): string {
  const files = [
    'tracking/system_health.md',
    'situation.md',
    'learnings/decisions.md',
  ];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(
        path.join(KNOWLEDGE_REPO_PATH, f),
        'utf8',
      );
      parts.push(`=== ${f} ===\n${content.slice(0, 2000)}`);
    } catch {
      /* skip */
    }
  }
  return parts.join('\n\n');
}

// ── Gemini call ─────────────────────────────────────

async function callGemini(prompt: string): Promise<string | null> {
  if (!GEMINI_KEY) {
    logger.warn('Research: GOOGLE_AI_API_KEY not set');
    return null;
  }

  try {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: {
        parts: [
          {
            text:
              'You are a research analyst for an AI assistant system called NanoClaw. ' +
              'Write concise, actionable findings in markdown. Czech or English based on source language. ' +
              'Focus on practical improvements, not theory.',
          },
        ],
      },
      generationConfig: { maxOutputTokens: 4096 },
    });

    const tmpFile = path.join(
      require('os').tmpdir(),
      'nanoclaw-research-payload.json',
    );
    fs.writeFileSync(tmpFile, payload);

    try {
      const raw = execFileSync(
        '/usr/bin/curl',
        [
          '-s',
          '--connect-timeout',
          '10',
          '--max-time',
          '60',
          '-X',
          'POST',
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          '-H',
          'Content-Type: application/json',
          '-d',
          `@${tmpFile}`,
        ],
        { timeout: 65_000, encoding: 'utf8' },
      );

      const data = JSON.parse(raw);
      let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      // Strip markdown code fences
      text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
      return text.trim() || null;
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Research: Gemini call failed');
    return null;
  }
}

// ── Research topics ─────────────────────────────────

// Built-in sources (always active)
const BUILTIN_SOURCES = [
  {
    name: 'Moltbook',
    fetch: () => fetchMoltbookFeed(15),
    format: (data: string[]) =>
      data.length > 0
        ? `Moltbook feed (${data.length} posts):\n${data.join('\n---\n')}`
        : null,
  },
  {
    name: 'Bluelabel Ventures',
    fetch: () => fetchBlog('https://www.bluelabel.ventures/'),
    format: (data: string | null) =>
      data ? `Bluelabel Ventures blog:\n${data}` : null,
  },
  {
    name: 'Anthropic Changelog',
    fetch: () =>
      fetchBlog('https://docs.anthropic.com/en/docs/about-claude/models'),
    format: (data: string | null) =>
      data ? `Anthropic models page:\n${data}` : null,
  },
  {
    name: 'Ollama Blog',
    fetch: () => fetchBlog('https://ollama.com/blog'),
    format: (data: string | null) => (data ? `Ollama blog:\n${data}` : null),
  },
];

const SOURCES_FILE = path.join(KNOWLEDGE_REPO_PATH, 'tracking', 'research_sources.md');

function loadDynamicSources(): { name: string; url: string }[] {
  try {
    const content = fs.readFileSync(SOURCES_FILE, 'utf8');
    const sources: { name: string; url: string }[] = [];
    const lines = content.split('\n');
    let inActive = false;
    for (const line of lines) {
      if (line.includes('## Aktivní zdroje')) inActive = true;
      else if (line.startsWith('## ')) inActive = false;
      if (!inActive) continue;
      const match = line.match(/^\|\s*(https?:\/\/\S+)\s*\|/);
      if (match) {
        const url = match[1];
        // Skip built-in sources
        if (BUILTIN_SOURCES.some((s) => url.includes(s.name.toLowerCase()))) continue;
        sources.push({ name: url.split('/')[2] || url, url });
      }
    }
    return sources;
  } catch {
    return [];
  }
}

function addSourceCandidate(url: string, reason: string): void {
  try {
    let content = fs.readFileSync(SOURCES_FILE, 'utf8');
    if (content.includes(url)) return; // already listed
    const date = new Date().toISOString().slice(0, 10);
    const newRow = `| ${url} | auto-discovered | research-agent | pending review |\n`;
    content = content.replace(
      '| | | | |\n',
      `${newRow}| | | | |\n`,
    );
    fs.writeFileSync(SOURCES_FILE, content);
    logger.info({ url, reason }, 'Research: new source candidate added');
  } catch {
    /* non-critical */
  }
}

// ── Main ────────────────────────────────────────────

export async function runResearchAgent(): Promise<void> {
  logger.info('Research agent starting');

  // 1. Fetch built-in sources
  const sourceSummaries: string[] = [];
  for (const src of BUILTIN_SOURCES) {
    try {
      const data = src.fetch();
      const formatted = src.format(data as never);
      if (formatted) {
        sourceSummaries.push(formatted);
        logger.info({ source: src.name }, 'Research: fetched source');
      }
    } catch (err) {
      logger.warn({ source: src.name, err }, 'Research: source failed');
    }
  }

  // 1b. Fetch dynamic sources from research_sources.md
  const dynamicSources = loadDynamicSources();
  for (const src of dynamicSources) {
    try {
      const text = fetchBlog(src.url);
      if (text) {
        sourceSummaries.push(`${src.name}:\n${text}`);
        logger.info({ source: src.name }, 'Research: fetched dynamic source');
      }
    } catch {
      /* skip */
    }
  }

  if (sourceSummaries.length === 0) {
    logger.warn('Research: no sources available, skipping');
    return;
  }

  // 2. Read current system state
  const currentState = readCurrentState();

  // 3. Build prompt
  const prompt = `You are researching improvements for NanoClaw — a personal AI assistant system.

CURRENT SYSTEM STATE:
${currentState.slice(0, 3000)}

EXTERNAL SOURCES (fetched today):
${sourceSummaries.join('\n\n---\n\n')}

TASK:
1. Identify the 3-5 most relevant/interesting findings from the external sources
2. For each: explain WHY it's relevant to NanoClaw and WHAT specifically could be improved
3. Check if any source mentions tools, techniques or patterns we don't use yet
4. Flag any security concerns or deprecation notices
5. SELF-IMPROVEMENT: Suggest 1-3 NEW sources (blogs, tools, newsletters, GitHub repos, forums) that would be valuable for future research. For each: provide exact URL and explain why it's relevant.

Output as markdown with sections:
## Key Findings
## Improvement Proposals
## New Tools/Techniques
## Risks/Concerns
## Suggested New Sources
(for each: URL, type, why relevant)

Be specific and actionable. Not "improve monitoring" but "add disk space trend prediction using last 7 days of metrics".`;

  // 4. Call Gemini
  const analysis = await callGemini(prompt);
  if (!analysis) {
    logger.warn('Research: Gemini analysis returned empty');
    return;
  }

  // 5. Write proposal
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  const proposalPath = path.join(PROPOSALS_DIR, `${date}-research.md`);

  const content = `---
date: ${date}
type: research
sources: ${sourceSummaries.length}
model: gemini-2.5-flash
---

# Research Findings — ${date}

${analysis}
`;

  fs.writeFileSync(proposalPath, content);
  logger.info(
    { path: proposalPath, length: content.length },
    'Research agent: proposal written',
  );

  // 6. Extract suggested new sources and add as candidates
  const urlMatches = analysis.matchAll(
    /(?:https?:\/\/[^\s)<>"]+)/g,
  );
  const suggestedSection = analysis
    .split(/##\s*Suggested New Sources/i)[1]
    ?.slice(0, 2000) || '';
  const suggestedUrls = [...suggestedSection.matchAll(/https?:\/\/[^\s)<>"]+/g)];
  for (const match of suggestedUrls) {
    const url = match[0].replace(/[.,;:]+$/, ''); // strip trailing punctuation
    if (
      !url.includes('moltbook.com') &&
      !url.includes('bluelabel.ventures') &&
      !url.includes('anthropic.com') &&
      !url.includes('ollama.com')
    ) {
      addSourceCandidate(url, 'auto-discovered by research agent');
    }
  }
}
