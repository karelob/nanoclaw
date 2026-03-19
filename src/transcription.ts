/**
 * Voice message transcription with A/B comparison.
 *
 * Runs both Groq Whisper and local whisper (Windows GPU) in parallel,
 * logs comparison to store/whisper-comparison.jsonl, and saves voice
 * samples to store/voice-samples/ for later evaluation.
 *
 * Fallback: Groq → Local → OpenAI.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

const envVars = readEnvFile([
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'WHISPER_LOCAL_URL',
]);

/**
 * Transcribe via Groq Whisper API (whisper-large-v3-turbo).
 */
async function transcribeGroq(
  tmpFile: string,
  apiKey: string,
): Promise<{ text: string | null; ms: number }> {
  const t0 = Date.now();
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(tmpFile),
    model: 'whisper-large-v3-turbo',
    language: 'cs',
  });

  return { text: transcription.text?.trim() || null, ms: Date.now() - t0 };
}

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
  const stdout = execFileSync('curl', [
    '-s', '--connect-timeout', '10', '--max-time', '30',
    '-X', 'POST', url,
    '-F', `file=@${tmpFile}`,
    '-F', 'language=cs',
  ], { timeout: 35_000 });

  const data = JSON.parse(stdout.toString()) as { text?: string };
  return { text: data.text?.trim() || null, ms: Date.now() - t0 };
}

/**
 * Save voice sample and log A/B comparison.
 */
function logComparison(
  groqResult: { text: string | null; ms: number },
  localResult: { text: string | null; ms: number },
  fileSize: number,
  sampleFile: string | null,
): void {
  try {
    const logFile = path.join(STORE_DIR, 'whisper-comparison.jsonl');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      fileSize,
      sample: sampleFile,
      groq: { text: groqResult.text, ms: groqResult.ms },
      local: { text: localResult.text, ms: localResult.ms },
      match: groqResult.text === localResult.text,
    });
    fs.appendFileSync(logFile, entry + '\n');
    logger.info(
      {
        groqMs: groqResult.ms,
        localMs: localResult.ms,
        match: groqResult.text === localResult.text,
        groqLen: groqResult.text?.length ?? 0,
        localLen: localResult.text?.length ?? 0,
      },
      'Whisper A/B comparison logged',
    );
  } catch {
    /* non-critical */
  }
}

/**
 * Transcribe an audio buffer using the best available provider.
 * When both Groq and Local are available, runs both for A/B comparison.
 * Fallback chain: Groq → Local → OpenAI.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice.ogg',
): Promise<string | null> {
  const groqKey = process.env.GROQ_API_KEY || envVars.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY;
  const localUrl = process.env.WHISPER_LOCAL_URL || envVars.WHISPER_LOCAL_URL;

  if (!groqKey && !openaiKey && !localUrl) {
    logger.warn(
      'No transcription provider configured (GROQ_API_KEY, OPENAI_API_KEY, or WHISPER_LOCAL_URL)',
    );
    return null;
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `nanoclaw-voice-${Date.now()}-${filename}`,
  );

  try {
    fs.writeFileSync(tmpFile, audioBuffer);
    const fileSize = audioBuffer.length;

    // Save voice sample for A/B evaluation
    let sampleFile: string | null = null;
    try {
      const samplesDir = path.join(STORE_DIR, 'voice-samples');
      fs.mkdirSync(samplesDir, { recursive: true });
      const sampleName = `${Date.now()}-${filename}`;
      fs.copyFileSync(tmpFile, path.join(samplesDir, sampleName));
      sampleFile = sampleName;
    } catch { /* non-critical */ }

    // A/B comparison mode: both Groq and Local available
    if (groqKey && localUrl) {
      try {
        const [groqResult, localResult] = await Promise.all([
          transcribeGroq(tmpFile, groqKey).catch((err): { text: string | null; ms: number } => {
            logger.warn({ err }, 'Groq transcription failed in A/B mode');
            return { text: null, ms: 0 };
          }),
          transcribeLocal(tmpFile, localUrl).catch((err): { text: string | null; ms: number } => {
            logger.warn({ err }, 'Local transcription failed in A/B mode');
            return { text: null, ms: 0 };
          }),
        ]);

        logComparison(groqResult, localResult, fileSize, sampleFile);

        // Return Groq result (primary), fall back to local
        if (groqResult.text) {
          logger.info(
            { provider: 'groq', chars: groqResult.text.length },
            'Transcribed voice message',
          );
          return groqResult.text;
        }
        if (localResult.text) {
          logger.info(
            { provider: 'local', chars: localResult.text.length },
            'Transcribed voice message (groq failed, local succeeded)',
          );
          return localResult.text;
        }
      } catch (err) {
        logger.warn({ err }, 'A/B comparison failed, trying individual providers');
      }
    }

    // Single provider fallback (if A/B didn't run or both failed)

    // 1. Try Groq
    if (groqKey) {
      try {
        const result = await transcribeGroq(tmpFile, groqKey);
        if (result.text) {
          logger.info(
            { provider: 'groq', chars: result.text.length },
            'Transcribed voice message',
          );
          return result.text;
        }
      } catch (err) {
        logger.warn({ err }, 'Groq transcription failed, trying fallback');
      }
    }

    // 2. Try local whisper server
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
        logger.warn({ err }, 'Local whisper failed, trying fallback');
      }
    }

    // 3. Try OpenAI (reliable, paid)
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
