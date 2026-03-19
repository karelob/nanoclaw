/**
 * Host-side commands triggered via Telegram (! prefix).
 * Runs directly on host — no container, no AI tokens.
 * Only available to main group.
 */
import { execFileSync, spawn } from 'child_process';
import path from 'path';

import { logger } from './logger.js';
import { SYNC_JOBS, checkJob, getFullHealthReport } from './sync-health.js';
import { Channel } from './types.js';

const PLIST_DIR = path.join(
  process.env.HOME || '/Users/karel',
  'Library/LaunchAgents',
);

async function reply(channel: Channel, jid: string, text: string) {
  await channel.sendMessage(jid, text);
}

function restartLaunchdJob(label: string): boolean {
  const plist = path.join(PLIST_DIR, `${label}.plist`);
  try {
    try {
      execFileSync('launchctl', ['unload', plist], { timeout: 5000 });
    } catch {
      /* may already be unloaded */
    }
    execFileSync('launchctl', ['load', plist], { timeout: 5000 });
    return true;
  } catch (err) {
    logger.warn({ err, label }, 'Failed to restart LaunchAgent');
    return false;
  }
}

async function cmdHelp(channel: Channel, jid: string) {
  const msg = [
    '*Dostupné příkazy*',
    '',
    '_Host příkazy (bez AI):_',
    '`!help` — tento přehled',
    '`!health` — stav sync jobů',
    '`!fix` — auto-diagnóza + restart selhávajících',
    '`!restart-syncs` — restart všech sync LaunchAgentů',
    '`!restart` — restart NanoClaw',
    '',
    '_Agent skills (AI v kontejneru):_',
    '`/contact <jméno>` — profil osoby z cone.db',
    '`/prep-trip <destinace datum>` — příprava cesty',
    '`/finance <firma> <rok/měsíc> <akce>` — finanční analýza',
    '  Firmy: baker, pinehill, pinehouse, pineinvest, pineair',
    '  Akce: výpis, faktury',
    '',
    '_Přirozený jazyk:_',
    '"Co mám zítra?" — kalendář',
    '"Emaily od X" — prohledá cone.db',
    '"Kdo je Y?" — profil osoby',
  ].join('\n');
  await reply(channel, jid, msg);
}

async function cmdHealth(channel: Channel, jid: string) {
  const report = getFullHealthReport();
  await reply(channel, jid, report);
}

async function cmdRestartSyncs(channel: Channel, jid: string) {
  const lines: string[] = [];
  for (const job of SYNC_JOBS) {
    const ok = restartLaunchdJob(job.launchdLabel);
    lines.push(ok ? `🔄 ${job.name} — restarted` : `❌ ${job.name} — failed`);
  }
  await reply(channel, jid, `*Restart syncs*\n${lines.join('\n')}`);
}

async function cmdRestart(channel: Channel, jid: string) {
  await reply(channel, jid, 'Restarting NanoClaw...');
  const uid = process.getuid?.() ?? 501;
  spawn('launchctl', ['kickstart', '-k', `gui/${uid}/com.nanoclaw`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function cmdFix(channel: Channel, jid: string) {
  // 1. Check health
  const results = SYNC_JOBS.map(checkJob);
  const failures = results.filter((r) => !r.ok);

  if (failures.length === 0) {
    await reply(channel, jid, '*Auto-fix*\nVšechny syncy OK, nic k opravě.');
    return;
  }

  // 2. Report issues and restart failed jobs
  const issueLines = failures.map((f) => `⚠️ ${f.job}: ${f.issue}`);
  const restartLines: string[] = [];

  for (const f of failures) {
    const ok = restartLaunchdJob(f.launchdLabel);
    restartLines.push(
      ok ? `🔄 ${f.job} — restarted` : `❌ ${f.job} — restart failed`,
    );
  }

  const msg = [
    '*Auto-fix Report*',
    '',
    '_Nalezené problémy:_',
    ...issueLines,
    '',
    '_Provedené akce:_',
    ...restartLines,
    '',
    'Zkontroluj za pár minut příkazem !health',
  ].join('\n');

  await reply(channel, jid, msg);
}

const COMMANDS: Record<
  string,
  (channel: Channel, jid: string) => Promise<void>
> = {
  '!help': cmdHelp,
  '!health': cmdHealth,
  '!restart-syncs': cmdRestartSyncs,
  '!restart': cmdRestart,
  '!fix': cmdFix,
};

/**
 * Handle a host command. Returns true if the message was a command.
 */
export async function handleHostCommand(
  text: string,
  chatJid: string,
  channel: Channel,
): Promise<boolean> {
  const cmd = text.trim().toLowerCase();
  const handler = COMMANDS[cmd];

  if (!handler) {
    // Unknown ! command — list available ones
    if (cmd.startsWith('!')) {
      const available = Object.keys(COMMANDS).join(', ');
      await reply(channel, chatJid, `Neznámý příkaz. Dostupné: ${available}`);
      return true;
    }
    return false;
  }

  logger.info({ cmd, chatJid }, 'Executing host command');
  await handler(channel, chatJid);
  return true;
}
