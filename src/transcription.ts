/**
 * Voice message transcription.
 *
 * Primary: local whisper (Windows GPU). Fallback: OpenAI whisper-1.
 * Groq disabled (was primary during A/B evaluation phase).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envVars = readEnvFile(['OPENAI_API_KEY', 'WHISPER_LOCAL_URL']);

/**
 * Transcribe via OpenAI Whisper API (whisper-1).
 */
async function transcribeOpenAI(
  tmpFile: string,
  apiKey: string,
): Promise<string | null> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(tmpFile),
    model: 'whisper-1',
    language: 'cs',
  });

  return transcription.text?.trim() || null;
}

/**
 * Transcribe via local whisper server (Windows GPU).
 * Uses curl to avoid Node.js undici connection pool caching issues.
 */
async function transcribeLocal(
  tmpFile: string,
  serverUrl: string,
): Promise<{ text: string | null; ms: number }> {
  const t0 = Date.now();
  const url = `${serverUrl}/v1/audio/transcriptions`;

  const { execFileSync } = await import('child_process');
  let stdout: Buffer;
  try {
    stdout = execFileSync(
      'curl',
      [
        '-s',
        '-w',
        '\n%{http_code}',
        '--connect-timeout',
        '10',
        '--max-time',
        '30',
        '-X',
        'POST',
        url,
        '-F',
        `file=@${tmpFile}`,
        '-F',
        'language=cs',
      ],
      { timeout: 35_000 },
    );
  } catch (err) {
    throw new Error(`curl failed: ${err instanceof Error ? err.message : err}`);
  }

  const output = stdout.toString().trim();
  const lines = output.split('\n');
  const httpCode = lines.pop()?.trim();
  const body = lines.join('\n').trim();

  if (httpCode !== '200') {
    throw new Error(`Local whisper HTTP ${httpCode}: ${body.slice(0, 100)}`);
  }

  const data = JSON.parse(body) as { text?: string };
  return { text: data.text?.trim() || null, ms: Date.now() - t0 };
}

/**
 * Transcribe an audio buffer. Chain: Local whisper → OpenAI whisper-1.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice.ogg',
): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY;
  const localUrl = process.env.WHISPER_LOCAL_URL || envVars.WHISPER_LOCAL_URL;

  if (!openaiKey && !localUrl) {
    logger.warn(
      'No transcription provider configured (OPENAI_API_KEY or WHISPER_LOCAL_URL)',
    );
    return null;
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `nanoclaw-voice-${Date.now()}-${filename}`,
  );

  try {
    fs.writeFileSync(tmpFile, audioBuffer);

    // 1. Local whisper (primary)
    if (localUrl) {
      try {
        const result = await transcribeLocal(tmpFile, localUrl);
        if (result.text) {
          logger.info(
            { provider: 'local', chars: result.text.length },
            'Transcribed voice message',
          );
          return result.text;
        }
      } catch (err) {
        logger.warn({ err }, 'Local whisper failed, falling back to OpenAI');
      }
    }

    // 2. OpenAI whisper-1 (fallback)
    if (openaiKey) {
      try {
        const text = await transcribeOpenAI(tmpFile, openaiKey);
        if (text) {
          logger.info(
            { provider: 'openai', chars: text.length },
            'Transcribed voice message',
          );
          return text;
        }
      } catch (err) {
        logger.error({ err }, 'OpenAI transcription failed');
      }
    }

    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}
