/**
 * Post-container hook — runs after every container exit.
 * 1. Auto-commits knowledge repo changes
 * 2. Detects and promotes new skills/scripts from session dir
 * 3. Appends to agent changelog
 *
 * Fire-and-forget: never blocks the caller, logs errors instead of throwing.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, KNOWLEDGE_REPO_PATH } from './config.js';
import { logger } from './logger.js';

const PROJECT_ROOT = process.cwd();
const STABLE_SKILLS = path.join(PROJECT_ROOT, 'container', 'skills');
const CHANGELOG_PATH = path.join(
  KNOWLEDGE_REPO_PATH,
  'tracking',
  'agent_changelog.md',
);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    timeout: 10_000,
    encoding: 'utf8',
  }).trim();
}

function isDirty(repoPath: string): boolean {
  try {
    const status = git(['status', '--porcelain'], repoPath);
    return status.length > 0;
  } catch {
    return false;
  }
}

function autoCommit(repoPath: string, message: string): string | null {
  try {
    if (!isDirty(repoPath)) return null;
    git(['add', '-A'], repoPath);
    git(['commit', '-m', message], repoPath);
    const stat = git(['diff', '--stat', 'HEAD~1'], repoPath);
    return stat;
  } catch (err) {
    logger.warn({ err, repoPath }, 'Post-container: auto-commit failed');
    return null;
  }
}

function detectNewSkills(groupFolder: string): string[] {
  const sessionSkills = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'skills',
  );
  if (!fs.existsSync(sessionSkills)) return [];

  const promoted: string[] = [];
  for (const name of fs.readdirSync(sessionSkills)) {
    const src = path.join(sessionSkills, name);
    const dst = path.join(STABLE_SKILLS, name);
    if (!fs.statSync(src).isDirectory()) continue;
    // Only promote if has SKILL.md (real skill, not temp dir)
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    if (fs.existsSync(dst)) continue; // already promoted

    try {
      fs.cpSync(src, dst, { recursive: true });
      // Remove __pycache__ if present
      const pycache = path.join(dst, '__pycache__');
      if (fs.existsSync(pycache)) fs.rmSync(pycache, { recursive: true });
      promoted.push(name);
      logger.info({ skill: name }, 'Post-container: promoted new skill');
    } catch (err) {
      logger.warn(
        { err, skill: name },
        'Post-container: failed to promote skill',
      );
    }
  }
  return promoted;
}

function detectNewScripts(groupFolder: string): string[] {
  const sessionScripts = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'scripts',
  );
  if (!fs.existsSync(sessionScripts)) return [];

  const stableScripts = path.join(STABLE_SKILLS, '_scripts');
  const promoted: string[] = [];

  for (const name of fs.readdirSync(sessionScripts)) {
    const src = path.join(sessionScripts, name);
    if (!fs.statSync(src).isFile()) continue;
    if (!name.endsWith('.py') && !name.endsWith('.sh')) continue;

    fs.mkdirSync(stableScripts, { recursive: true });
    const dst = path.join(stableScripts, name);
    if (fs.existsSync(dst)) continue;

    try {
      fs.copyFileSync(src, dst);
      promoted.push(name);
      logger.info({ script: name }, 'Post-container: promoted new script');
    } catch (err) {
      logger.warn(
        { err, script: name },
        'Post-container: failed to promote script',
      );
    }
  }
  return promoted;
}

function appendChangelog(
  groupName: string,
  knowledgeChanges: string | null,
  promotedSkills: string[],
  promotedScripts: string[],
): void {
  if (
    !knowledgeChanges &&
    promotedSkills.length === 0 &&
    promotedScripts.length === 0
  ) {
    return;
  }

  try {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const lines: string[] = [`\n## ${now} — ${groupName}`];

    if (knowledgeChanges) {
      lines.push('- Knowledge repo auto-committed:');
      for (const line of knowledgeChanges.split('\n').slice(0, 10)) {
        if (line.trim()) lines.push(`  ${line.trim()}`);
      }
    }
    if (promotedSkills.length > 0) {
      lines.push(`- Nové skills: ${promotedSkills.join(', ')}`);
    }
    if (promotedScripts.length > 0) {
      lines.push(`- Nové skripty: ${promotedScripts.join(', ')}`);
    }

    if (!fs.existsSync(CHANGELOG_PATH)) {
      fs.mkdirSync(path.dirname(CHANGELOG_PATH), { recursive: true });
      fs.writeFileSync(
        CHANGELOG_PATH,
        '# Agent Changelog\n\n> Automatický i manuální záznam změn provedených agenty.\n',
      );
    }
    fs.appendFileSync(CHANGELOG_PATH, lines.join('\n') + '\n');
  } catch (err) {
    logger.warn({ err }, 'Post-container: failed to append changelog');
  }
}

/**
 * Run the post-container hook. Fire-and-forget.
 */
export function runPostContainerHook(
  groupFolder: string,
  groupName: string,
): void {
  // Defer to next tick so we don't block the caller
  setImmediate(() => {
    try {
      logger.debug({ groupFolder }, 'Post-container hook starting');

      // 1. Detect and promote new skills/scripts
      const promotedSkills = detectNewSkills(groupFolder);
      const promotedScripts = detectNewScripts(groupFolder);

      // 2. Auto-commit knowledge repo
      const knowledgeChanges = autoCommit(
        KNOWLEDGE_REPO_PATH,
        `auto: ${groupName} session changes`,
      );

      // 3. Append to changelog (before committing nanoclaw repo)
      appendChangelog(
        groupName,
        knowledgeChanges,
        promotedSkills,
        promotedScripts,
      );

      // 4. If knowledge changelog was updated, commit that too
      if (
        knowledgeChanges ||
        promotedSkills.length > 0 ||
        promotedScripts.length > 0
      ) {
        autoCommit(KNOWLEDGE_REPO_PATH, `auto: changelog update`);
      }

      // 5. Auto-commit nanoclaw repo if skills were promoted
      if (promotedSkills.length > 0 || promotedScripts.length > 0) {
        autoCommit(
          PROJECT_ROOT,
          `auto: promote ${[...promotedSkills, ...promotedScripts].join(', ')} from agent session`,
        );
      }

      // Note: pending commitments are processed by com.cone.commitments LaunchAgent (7:00)
      // which has macOS Reminders permissions. Post-container hook does NOT process them.

      logger.info(
        {
          groupFolder,
          knowledgeCommitted: !!knowledgeChanges,
          promotedSkills,
          promotedScripts,
        },
        'Post-container hook completed',
      );
    } catch (err) {
      logger.error({ err, groupFolder }, 'Post-container hook failed');
    }
  });
}
