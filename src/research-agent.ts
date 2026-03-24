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
import { readEnvFile, readEnvFileFrom } from './env.js';

const envVars = readEnvFile(['GOOGLE_AI_API_KEY', 'MOLTBOOK_API_KEY']);
const coneEnv = readEnvFileFrom(
  path.join(process.env.HOME || '/Users/karel', 'Develop/nano-cone/cone/config/.env'),
  ['GOOGLE_AI_API_KEY', 'MOLTBOOK_API_KEY'],
);

const GEMINI_KEY = process.env.GOOGLE_AI_API_KEY || envVars.GOOGLE_AI_API_KEY || coneEnv.GOOGLE_AI_API_KEY;
const MOLTBOOK_KEY = process.env.MOLTBOOK_API_KEY || envVars.MOLTBOOK_API_KEY || coneEnv.MOLTBOOK_API_KEY;

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

/** Fetch RSS/Atom feed → extract recent items as text */
function fetchRss(url: string, maxItems = 5): string | null {
  const xml = fetchUrl(url, 20);
  if (!xml) return null;
  const items: string[] = [];

  // Try RSS <item> first, then Atom <entry>
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) && items.length < maxItems) {
    const block = match[1];
    const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '';
    // RSS uses <description>, Atom uses <content> or <summary>
    const desc = block.match(/<(?:description|content|summary)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|content|summary)>/)?.[1] || '';
    const pubDate = block.match(/<(?:pubDate|published|updated)>(.*?)<\/(?:pubDate|published|updated)>/)?.[1] || '';
    // Strip HTML from description
    const cleanDesc = desc.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    items.push(`[${pubDate}] ${title}\n${cleanDesc.slice(0, 800)}`);
  }
  return items.length > 0 ? items.join('\n---\n') : null;
}

/** Fetch GitHub releases via API */
function fetchGithubReleases(repo: string, count = 3): string | null {
  const raw = fetchUrl(`https://api.github.com/repos/${repo}/releases?per_page=${count}`, 15);
  if (!raw) return null;
  try {
    const releases = JSON.parse(raw);
    if (!Array.isArray(releases)) return null;
    return releases
      .map((r: { tag_name?: string; name?: string; body?: string; published_at?: string }) =>
        `[${r.tag_name}] ${r.name || ''} (${(r.published_at || '').slice(0, 10)})\n${(r.body || '').slice(0, 1000)}`)
      .join('\n---\n');
  } catch {
    return null;
  }
}

/** Fetch web page via Jina reader proxy → clean markdown */
function fetchViaJina(url: string): string | null {
  const md = fetchUrl(`https://r.jina.ai/${url}`, 20);
  if (!md || md.length < 100) return null;
  return md.slice(0, 5000);
}

/** Fetch a source based on its type */
function fetchSource(url: string, type: string): string | null {
  switch (type) {
    case 'rss': return fetchRss(url);
    case 'github': {
      // Extract owner/repo from GitHub URL
      const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
      return match ? fetchGithubReleases(match[1]) : null;
    }
    case 'jina': return fetchViaJina(url);
    default: return fetchViaJina(url); // fallback to jina
  }
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

// ── Moltbook interaction ─────────────────────────────

function moltbookPost(
  title: string,
  body: string,
  submolt = 'agents',
): boolean {
  if (!MOLTBOOK_KEY) return false;
  try {
    const payload = JSON.stringify({ title, body, submolt_name: submolt });
    const tmpFile = path.join(require('os').tmpdir(), 'moltbook-post.json');
    fs.writeFileSync(tmpFile, payload);
    try {
      execFileSync(
        '/usr/bin/curl',
        [
          '-s',
          '--connect-timeout',
          '10',
          '--max-time',
          '15',
          '-X',
          'POST',
          'https://www.moltbook.com/api/v1/posts',
          '-H',
          `Authorization: Bearer ${MOLTBOOK_KEY}`,
          '-H',
          'Content-Type: application/json',
          '-d',
          `@${tmpFile}`,
        ],
        { timeout: 20_000, encoding: 'utf8' },
      );
      logger.info({ title, submolt }, 'Research: Moltbook post created');
      return true;
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Research: Moltbook post failed');
    return false;
  }
}

// Moltbook is special (API, not web scrape) — always available if key exists
function fetchMoltbookSource(): string | null {
  const posts = fetchMoltbookFeed(15);
  return posts.length > 0
    ? `Moltbook feed (${posts.length} posts):\n${posts.join('\n---\n')}`
    : null;
}

const SOURCES_FILE = path.join(
  KNOWLEDGE_REPO_PATH,
  'tracking',
  'research_sources.md',
);

function loadDynamicSources(): { name: string; url: string; type: string }[] {
  try {
    const content = fs.readFileSync(SOURCES_FILE, 'utf8');
    const sources: { name: string; url: string; type: string }[] = [];
    const lines = content.split('\n');
    let inActive = false;
    for (const line of lines) {
      if (line.includes('## Aktivní zdroje')) inActive = true;
      else if (line.startsWith('## ')) inActive = false;
      if (!inActive) continue;
      // Format: | URL | Type | Added | Reason |
      const match = line.match(/^\|\s*(https?:\/\/\S+)\s*\|\s*(\S+)\s*\|/);
      if (match) {
        const url = match[1];
        const type = match[2].toLowerCase();
        sources.push({ name: url.split('/')[2] || url, url, type });
      }
    }
    return sources;
  } catch {
    return [];
  }
}

/** Search via Jina reader on Google results page */
function fetchGoogleSearch(query: string): string | null {
  const encoded = encodeURIComponent(query);
  // Use Jina reader to render Google search results page
  const result = fetchUrl(`https://r.jina.ai/https://www.google.com/search?q=${encoded}&num=5`, 20);
  if (!result || result.length < 200) return null;
  return result.slice(0, 5000);
}

function addSourceCandidate(url: string, reason: string): void {
  try {
    let content = fs.readFileSync(SOURCES_FILE, 'utf8');
    if (content.includes(url)) return; // already listed
    const date = new Date().toISOString().slice(0, 10);
    const newRow = `| ${url} | auto-discovered | research-agent | pending review |\n`;
    content = content.replace('| | | | |\n', `${newRow}| | | | |\n`);
    fs.writeFileSync(SOURCES_FILE, content);
    logger.info({ url, reason }, 'Research: new source candidate added');
  } catch {
    /* non-critical */
  }
}

// ── Main ────────────────────────────────────────────

async function sendResearchReport(
  analysis: string,
  sourceCount: number,
  newSourceCount: number,
  sendTelegram: ((text: string) => Promise<void>) | null,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);

  // 1. Telegram — short summary
  if (sendTelegram) {
    try {
      // Extract key sections for a concise message
      const findings =
        analysis.match(/##\s*Key Findings[\s\S]*?(?=##|$)/)?.[0] || '';
      const risks =
        analysis.match(/##\s*Risks\/Concerns[\s\S]*?(?=##|$)/)?.[0] || '';
      const newSources =
        analysis.match(/##\s*Suggested New Sources[\s\S]*?(?=##|$)/)?.[0] || '';

      // Build concise Telegram message
      let msg = `*🔬 Research Report — ${date}*\n`;
      msg += `Sources: ${sourceCount} | New sources: ${newSourceCount}\n\n`;

      // Extract bullet points from findings (first 5)
      const bullets = findings.match(/[-•]\s+.+/g)?.slice(0, 5) || [];
      if (bullets.length > 0) {
        msg += `*Findings:*\n${bullets.join('\n')}\n\n`;
      }

      const riskBullets = risks.match(/[-•]\s+.+/g)?.slice(0, 3) || [];
      if (riskBullets.length > 0) {
        msg += `*Risks:*\n${riskBullets.join('\n')}\n\n`;
      }

      if (newSourceCount > 0) {
        const srcBullets =
          newSources.match(/https?:\/\/[^\s)<>"]+/g)?.slice(0, 3) || [];
        if (srcBullets.length > 0) {
          msg += `*New sources:*\n${srcBullets.map((u: string) => `• ${u}`).join('\n')}`;
        }
      }

      // Trim to Telegram limit
      if (msg.length > 4000)
        msg = msg.slice(0, 3950) + '\n\n_(full report in email)_';
      await sendTelegram(msg);
    } catch (err) {
      logger.warn({ err }, 'Research: Telegram report failed');
    }
  }

  // 2. Email — full HTML report
  try {
    // Convert markdown to basic HTML
    let html = analysis
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');

    html = `<html><body style="font-family: sans-serif; font-size: 14px; line-height: 1.6;">
<h2>🔬 Research Report — ${date}</h2>
<p><i>Sources: ${sourceCount} | Model: Gemini 2.5 Flash</i></p>
<hr>
${html}
</body></html>`;

    // Use Gmail to send
    const gmailSend = path.join(
      process.env.HOME || '/Users/karel',
      'Develop/nano-cone/cone/scripts',
    );
    const sendScript = `
import sys
sys.path.insert(0, '${gmailSend}')
from newsletter_summary import get_gmail_service, send_gmail
service = get_gmail_service()
import sys
body = sys.stdin.read()
result = send_gmail(service, '🔬 Research Report — ${date}', body)
print(result)
`;
    execFileSync('python3', ['-c', sendScript], {
      input: html,
      timeout: 15_000,
      encoding: 'utf8',
    });
    logger.info('Research: email report sent');
  } catch (err) {
    logger.warn({ err }, 'Research: email report failed');
  }
}

export async function runResearchAgent(
  sendTelegram?: (text: string) => Promise<void>,
): Promise<void> {
  logger.info('Research agent starting');

  // 1. Fetch Moltbook (API-based, always if key exists)
  const sourceSummaries: string[] = [];
  const moltbook = fetchMoltbookSource();
  if (moltbook) {
    sourceSummaries.push(moltbook);
    logger.info({ source: 'Moltbook' }, 'Research: fetched source');
  }

  // 2. Fetch all sources from research_sources.md using typed fetchers
  const dynamicSources = loadDynamicSources();
  for (const src of dynamicSources) {
    try {
      const text = fetchSource(src.url, src.type);
      if (text) {
        sourceSummaries.push(`[${src.type}] ${src.name}:\n${text}`);
        logger.info({ source: src.name, type: src.type }, 'Research: fetched source');
      } else {
        logger.warn({ source: src.name, type: src.type }, 'Research: source returned empty');
      }
    } catch {
      /* skip */
    }
  }

  // 3. Google search for recent relevant topics
  const searchQueries = [
    'Claude Code SDK agent latest updates 2026',
    'AI personal assistant architecture best practices 2026',
  ];
  for (const query of searchQueries) {
    try {
      const results = fetchGoogleSearch(query);
      if (results) {
        sourceSummaries.push(`[search] "${query}":\n${results}`);
        logger.info({ query }, 'Research: Google search completed');
      }
    } catch {
      /* skip */
    }
  }

  if (sourceSummaries.length === 0) {
    logger.warn('Research: no sources available, skipping');
    return;
  }

  // 4. Build prompt
  const prompt = `You are researching improvements for NanoClaw — a personal AI assistant system (Node.js, Claude Agent SDK, containerized agents, channel-based messaging).

EXTERNAL SOURCES (fetched today):
${sourceSummaries.join('\n\n---\n\n')}

TASK:
Analyze the external sources above and extract NEW information we might not already know.

For each finding:
- What exactly changed, was released, or was announced? (version numbers, dates, specifics)
- What should NanoClaw concretely do differently? (specific code changes, new dependencies, config tweaks)
- Skip generic advice ("improve monitoring", "add tests"). Only include findings with a clear, specific action.
- Do NOT diagnose NanoClaw system problems — focus purely on what's new externally.

Also:
- Flag any security vulnerabilities, breaking changes, or deprecation notices in tools we use
- Suggest 1-3 NEW sources (exact URLs) that would be valuable for future research runs

Output as markdown with sections:
## Key Findings
(for each: what exactly changed/was released, and what NanoClaw should do about it)
## New Tools/Techniques
(only if genuinely new and applicable)
## Risks/Concerns
(security, deprecations, breaking changes)
## Suggested New Sources
(for each: URL, type, why relevant)

Be specific and actionable. Not "consider upgrading Node" but "Node 22.4.0 released on 2026-03-20, adds X feature — relevant because NanoClaw uses Y".`;

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
  const suggestedSection =
    analysis.split(/##\s*Suggested New Sources/i)[1]?.slice(0, 2000) || '';
  const suggestedUrls = [
    ...suggestedSection.matchAll(/https?:\/\/[^\s)<>"]+/g),
  ];
  let newSourceCount = 0;
  for (const match of suggestedUrls) {
    const url = match[0].replace(/[.,;:`'"\])+]+$/, '');
    if (
      !url.includes('moltbook.com') &&
      !url.includes('bluelabel.ventures') &&
      !url.includes('anthropic.com') &&
      !url.includes('ollama.com')
    ) {
      addSourceCandidate(url, 'auto-discovered by research agent');
      newSourceCount++;
    }
  }

  // 7. Send report (Telegram + email)
  await sendResearchReport(
    analysis,
    sourceSummaries.length,
    newSourceCount,
    sendTelegram || null,
  );
}
