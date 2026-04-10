import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

// Central secrets store — single source of truth for all nano-cone components
const CENTRAL_ENV = path.join(
  os.homedir(),
  'Develop',
  'nano-cone',
  'cone',
  'config',
  '.env',
);

/**
 * Parse the central .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  return readEnvFileFrom(CENTRAL_ENV, keys);
}

/** Read specific keys from an arbitrary .env file path. */
export function readEnvFileFrom(
  envFile: string,
  keys: string[],
): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, `.env file not found: ${envFile}`);
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
