import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private botId: number | null = null; // Set on connect from botInfo
  private mluvkaBotId: number; // MLUVKA_BOT_ID env var (0 = disabled)
  private karelTelegramId: number; // KAREL_TELEGRAM_ID env var (0 = not set)

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    const env = readEnvFile(['MLUVKA_BOT_ID', 'KAREL_TELEGRAM_ID']);
    this.mluvkaBotId =
      parseInt(process.env.MLUVKA_BOT_ID || env.MLUVKA_BOT_ID || '0') || 0;
    this.karelTelegramId =
      parseInt(process.env.KAREL_TELEGRAM_ID || env.KAREL_TELEGRAM_ID || '0') ||
      0;
  }

  /**
   * Determine whether a message should be processed and how.
   *
   * Returns:
   *   'normal'        — process as a regular Karel message
   *   'mluvka_proxy'  — message from Mluvka bot (may be proxy voice from Karel)
   *   'ignore'        — discard silently
   */
  private _shouldProcess(ctx: any): 'normal' | 'mluvka_proxy' | 'ignore' {
    const fromId: number | undefined = ctx.from?.id;
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

    // Always discard own messages (Šiška sees itself in groups via polling)
    if (this.botId && fromId === this.botId) return 'ignore';

    // Private chat: always Karel, process normally
    if (!isGroup) return 'normal';

    // Group with Mluvka configured: check if it's the Mluvka proxy bot
    if (this.mluvkaBotId && fromId === this.mluvkaBotId) return 'mluvka_proxy';

    // Group with Karel ID configured: only allow messages from Karel
    if (this.karelTelegramId) {
      return fromId === this.karelTelegramId ? 'normal' : 'ignore';
    }

    // Group without Karel ID config: process non-bot senders (backward compat)
    return ctx.from?.is_bot ? 'ignore' : 'normal';
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      // Filter by sender role
      const processType = this._shouldProcess(ctx);
      if (processType === 'ignore') return;
      if (processType === 'mluvka_proxy') {
        // Accept @siska_bot commands and [proxy:karel] voice transcriptions from Mluvka
        if (ctx.message.text.startsWith('@siska_bot')) {
          ctx.message.text = ctx.message.text.replace(/^@\w+\s*/, '');
        } else if (ctx.message.text.startsWith('[proxy:karel]')) {
          ctx.message.text = ctx.message.text.replace(
            /^\[proxy:karel\]\s*/,
            '',
          );
        } else {
          return;
        }
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // If this is a reply, prepend the original message so the agent has context.
      const replyTo = ctx.message.reply_to_message;
      if (replyTo) {
        const replyText = replyTo.text || replyTo.caption || '[media]';
        const replyFrom = replyTo.from?.is_bot
          ? ASSISTANT_NAME
          : replyTo.from?.first_name || replyTo.from?.username || 'Unknown';
        const quotedLines = replyText
          .split('\n')
          .map((l: string) => `> ${l}`)
          .join('\n');
        content = `${quotedLines}\n\n${content}`;
        logger.debug(
          { chatJid, replyFrom, replyLength: replyText.length },
          'Reply context attached',
        );
      }

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      if (this._shouldProcess(ctx) === 'ignore') return;

      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    // Voice messages: download audio and transcribe via Whisper
    // Also handles Mluvka proxy voice (caption contains [proxy:karel])
    this.bot.on('message:voice', async (ctx) => {
      const processType = this._shouldProcess(ctx);
      if (processType === 'ignore') return;

      // Mluvka proxy: only accept voice with [proxy:karel] caption
      const caption = ctx.message.caption || '';
      if (
        processType === 'mluvka_proxy' &&
        !caption.includes('[proxy:karel]')
      ) {
        return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      // For Mluvka proxy, present as Karel (sender filtering already done above)
      const senderName =
        processType === 'mluvka_proxy'
          ? 'Karel'
          : ctx.from?.first_name ||
            ctx.from?.username ||
            ctx.from?.id?.toString() ||
            'Unknown';
      const senderId =
        processType === 'mluvka_proxy'
          ? this.karelTelegramId.toString() || ctx.from?.id?.toString() || ''
          : ctx.from?.id?.toString() || '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message - transcription unavailable]';

      try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (response.ok) {
          const audioBuffer = Buffer.from(await response.arrayBuffer());
          const transcript = await transcribeAudio(audioBuffer, 'voice.ogg');
          if (transcript) {
            content = `[Voice: ${transcript}]`;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to download/transcribe voice message');
      }

      if (processType === 'mluvka_proxy') {
        logger.info(
          { chatJid, transcript: content },
          'Mluvka proxy voice processed as Karel',
        );
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          this.botId = botInfo.id;
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(
            `\n  Telegram bot: @${botInfo.username} (id: ${botInfo.id})`,
          );
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      }).catch((err) => {
        const is409 =
          err?.error_code === 409 || String(err?.message).includes('409');
        if (is409) {
          logger.warn('Telegram 409 conflict — reconnecting in 35s');
          // Recreate bot from scratch — grammY can't restart a failed instance
          setTimeout(() => this.connect(), 35_000);
        } else {
          logger.error({ err }, 'Telegram polling stopped');
        }
        resolve(); // don't block startup
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');

      // Log outbound message content for debugging (retain 30 days)
      try {
        const logFile = path.join(STORE_DIR, 'outbound-messages.jsonl');
        const entry = JSON.stringify({
          ts: new Date().toISOString(),
          jid,
          length: text.length,
          content: text,
        });
        fs.appendFileSync(logFile, entry + '\n');
      } catch {
        /* non-critical */
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
