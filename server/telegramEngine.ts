import crypto from 'node:crypto';
import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { StringSession } from 'telegram/sessions';
import {
  BOT_MENU_COMMANDS,
  type BotReply,
  handleCallbackAction,
  handleForwardedChannelDiscovery,
  handleTextCommand,
} from './botCommander.ts';
import { FloodWaitError, rateLimitQueue } from './rateLimiter.ts';
import { store } from './store.ts';
import type { ChatKind, EngineStatus, IncomingMessagePayload, MediaType } from './types.ts';

function toGrammyKeyboard(reply: BotReply): InlineKeyboard | undefined {
  if (!reply.inlineKeyboard || reply.inlineKeyboard.length === 0) return undefined;
  const kb = new InlineKeyboard();
  reply.inlineKeyboard.forEach((row, idx) => {
    for (const btn of row) {
      kb.text(btn.text, btn.callbackData);
    }
    if (idx < reply.inlineKeyboard!.length - 1) {
      kb.row();
    }
  });
  return kb;
}

function parseAdminAllowlist(): Set<string> {
  const raw = process.env.TELEGRAM_ADMIN_IDS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function classifyGrammyMessage(msg: Record<string, any>): {
  mediaType: MediaType;
  fileName?: string;
  fileSizeMb?: number;
  fileUniqueId?: string;
  caption?: string;
  text?: string;
} {
  if (msg.video) {
    return {
      mediaType: 'video',
      fileName: msg.video.file_name ?? 'video.mp4',
      fileSizeMb: msg.video.file_size ? msg.video.file_size / (1024 * 1024) : undefined,
      fileUniqueId: msg.video.file_unique_id,
      caption: msg.caption,
    };
  }
  if (msg.document) {
    return {
      mediaType: 'document',
      fileName: msg.document.file_name ?? 'document',
      fileSizeMb: msg.document.file_size ? msg.document.file_size / (1024 * 1024) : undefined,
      fileUniqueId: msg.document.file_unique_id,
      caption: msg.caption,
    };
  }
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      mediaType: 'photo',
      fileSizeMb: largest.file_size ? largest.file_size / (1024 * 1024) : undefined,
      fileUniqueId: largest.file_unique_id,
      caption: msg.caption,
    };
  }
  if (msg.audio) {
    return {
      mediaType: 'audio',
      fileName: msg.audio.file_name ?? msg.audio.title,
      fileSizeMb: msg.audio.file_size ? msg.audio.file_size / (1024 * 1024) : undefined,
      fileUniqueId: msg.audio.file_unique_id,
      caption: msg.caption,
    };
  }
  if (msg.voice) {
    return {
      mediaType: 'voice',
      fileUniqueId: msg.voice.file_unique_id,
      caption: msg.caption,
    };
  }
  if (msg.animation) {
    return {
      mediaType: 'animation',
      fileName: msg.animation.file_name,
      fileUniqueId: msg.animation.file_unique_id,
      caption: msg.caption,
    };
  }
  if (msg.sticker) {
    return {
      mediaType: 'sticker',
      fileUniqueId: msg.sticker.file_unique_id,
    };
  }
  if (msg.poll) {
    return {
      mediaType: 'poll',
      text: msg.poll.question,
    };
  }
  return {
    mediaType: 'text',
    text: msg.text ?? '',
  };
}

class TelegramEngine {
  private bot: Bot | null = null;
  private userbot: TelegramClient | null = null;
  private botRunning = false;
  private botUsername: string | undefined;
  private userbotRunning = false;
  private userbotAccount: string | undefined;
  private lastError: string | undefined;
  private startedAt = Date.now();
  private reconnectTimer: NodeJS.Timeout | null = null;

  public getStatus(): EngineStatus {
    const botToken = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
    const userbotReady = Boolean(
      process.env.TELEGRAM_API_ID?.trim() &&
        process.env.TELEGRAM_API_HASH?.trim() &&
        process.env.TELEGRAM_USERBOT_SESSION?.trim(),
    );

    return {
      botApiConfigured: botToken,
      botApiRunning: this.botRunning,
      botUsername: this.botUsername,
      userbotConfigured: userbotReady,
      userbotRunning: this.userbotRunning,
      userbotAccount: this.userbotAccount,
      adminRestrictionEnabled: parseAdminAllowlist().size > 0,
      passcodeProtected: Boolean(process.env.DASHBOARD_PASSCODE?.trim()),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      lastError: this.lastError,
    };
  }

  public async start(): Promise<void> {
    this.registerQueueExecutor();
    await Promise.allSettled([this.startBotApi(), this.startUserbot()]);
  }

  public async syncUserbotSourceJoin(identifier: string): Promise<void> {
    if (!this.userbot || !this.userbotRunning) return;
    try {
      const clean = identifier.replace(/^@/, '').trim();
      if (!clean || /^-?\d+$/.test(clean)) return;
      await this.userbot.invoke(new Api.channels.JoinChannel({ channel: clean }));
    } catch {
      // Ignore if already joined or private channel
    }
  }

  private registerQueueExecutor(): void {
    rateLimitQueue.setExecutor(async ({ connection, source, destination, payload, transformedCaption, mode }) => {
      // Playground / simulated messages execute cleanly without calling Telegram network APIs
      if (payload.via === 'playground') {
        return {
          transport: 'simulation',
          detail: `${mode === 'copy' ? 'Copied' : 'Forwarded'} cleanly via ${
            connection.filters.preferUserbot ? 'Userbot MTProto' : 'Bot API'
          } queue`,
        };
      }

      // 1. Prefer MTProto Userbot for large files/videos or open-channel sources
      if (connection.filters.preferUserbot && this.userbot && this.userbotRunning && payload.rawForwardRef) {
        try {
          const fromPeer = /^\-?\d+$/.test(source.telegramChatId)
            ? Number(source.telegramChatId)
            : source.telegramChatId;
          const toPeer = /^\-?\d+$/.test(destination.telegramChatId)
            ? Number(destination.telegramChatId)
            : destination.telegramChatId;

          if (mode === 'forward') {
            await this.userbot.forwardMessages(toPeer, {
              fromPeer,
              messages: [payload.rawForwardRef.messageId],
            });
          } else {
            const msgs = await this.userbot.getMessages(fromPeer, {
              ids: [payload.rawForwardRef.messageId],
            });
            const original = msgs?.[0];
            if (original) {
              await this.userbot.sendMessage(toPeer, {
                message: transformedCaption,
                file: original.media ?? undefined,
              });
            }
          }

          return {
            transport: 'userbot',
            detail: `MTProto Userbot ${mode} delivered to ${destination.title}`,
          };
        } catch (err: any) {
          if (typeof err?.seconds === 'number' && err.seconds > 0) {
            throw new FloodWaitError(err.seconds, err.message);
          }
          // Fall through to Bot API if available
          if (!this.bot || !this.botRunning) {
            throw err;
          }
        }
      }

      // 2. Telegram Bot API delivery (copyMessage / forwardMessage)
      if (this.bot && this.botRunning && payload.rawForwardRef) {
        try {
          if (mode === 'forward') {
            await this.bot.api.forwardMessage(
              destination.telegramChatId,
              payload.rawForwardRef.fromChatId,
              payload.rawForwardRef.messageId,
            );
          } else {
            await this.bot.api.copyMessage(
              destination.telegramChatId,
              payload.rawForwardRef.fromChatId,
              payload.rawForwardRef.messageId,
              transformedCaption
                ? { caption: transformedCaption }
                : undefined,
            );
          }
          return {
            transport: 'bot_api',
            detail: `Bot API ${mode} delivered to ${destination.title}`,
          };
        } catch (err: any) {
          if (err instanceof GrammyError && err.error_code === 429) {
            const retryAfter = err.parameters?.retry_after ?? 5;
            throw new FloodWaitError(retryAfter, err.description);
          }
          throw err;
        }
      }

      return {
        transport: 'simulation',
        detail: `Queued in preview mode (configure TELEGRAM_BOT_TOKEN or Userbot secrets for live Telegram delivery)`,
      };
    });
  }

  private async startBotApi(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      return;
    }

    try {
      const bot = new Bot(token);
      this.bot = bot;

      const isAuthorized = (userId?: number): boolean => {
        const allow = parseAdminAllowlist();
        if (allow.size === 0) return true;
        return userId !== undefined && allow.has(String(userId));
      };

      // Always register Menu Button commands so the Telegram menu always shows every command
      await bot.api.setMyCommands(BOT_MENU_COMMANDS);

      // 1. Detect when bot is added to ANY channel or group (as admin or regular member)
      bot.on('my_chat_member', async (ctx) => {
        try {
          const update = ctx.myChatMember;
          const newStatus = update.new_chat_member.status;
          if (newStatus === 'member' || newStatus === 'administrator') {
            const chat = update.chat;
            const kind: ChatKind =
              chat.type === 'channel'
                ? 'channel'
                : chat.type === 'supergroup'
                  ? 'supergroup'
                  : 'group';
            const title = 'title' in chat && chat.title ? chat.title : String(chat.id);
            const username = 'username' in chat ? chat.username : undefined;

            const { reply } = handleForwardedChannelDiscovery({
              telegramChatId: String(chat.id),
              title,
              username,
              kind,
              accessMode: newStatus === 'administrator' ? 'bot_admin' : 'userbot_open',
              isBotAdmin: newStatus === 'administrator',
              originNote: newStatus === 'administrator' ? 'Bot added as Admin' : 'Bot added to chat',
            });

            const actorId = update.from?.id;
            if (actorId && isAuthorized(actorId)) {
              await bot.api.sendMessage(actorId, reply.text, {
                reply_markup: toGrammyKeyboard(reply),
              });
            }
          }
        } catch (err) {
          console.error('[BotAPI] my_chat_member handler error:', err);
        }
      });

      // 2. Private chat messages: forwarded posts, commands, @username/links
      bot.on('message', async (ctx) => {
        const msg = ctx.message as Record<string, any>;

        // Live group/supergroup source listener
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
          const classified = classifyGrammyMessage(msg);
          rateLimitQueue.handleIncomingMessage({
            id: `bot_${crypto.randomBytes(5).toString('hex')}`,
            sourceTelegramChatId: String(ctx.chat.id),
            sourceTitle: 'title' in ctx.chat && ctx.chat.title ? ctx.chat.title : String(ctx.chat.id),
            messageId: msg.message_id,
            ...classified,
            via: 'bot_api',
            rawForwardRef: {
              fromChatId: String(ctx.chat.id),
              messageId: msg.message_id,
            },
          });
          return;
        }

        // Private control chat with user
        if (ctx.chat.type !== 'private') return;
        if (!isAuthorized(ctx.from?.id)) {
          await ctx.reply('Unauthorized. Add your Telegram User ID to TELEGRAM_ADMIN_IDS.');
          return;
        }

        const sessionKey = `tg_${ctx.from?.id ?? ctx.chat.id}`;

        // Detect forwarded post from ANY channel or group!
        const origin = msg.forward_origin;
        if (origin && (origin.type === 'channel' || origin.type === 'chat')) {
          const originChat = origin.chat;
          if (originChat) {
            const kind: ChatKind =
              originChat.type === 'channel'
                ? 'channel'
                : originChat.type === 'supergroup'
                  ? 'supergroup'
                  : 'group';
            const { channel, reply } = handleForwardedChannelDiscovery({
              telegramChatId: String(originChat.id),
              title: originChat.title ?? String(originChat.id),
              username: originChat.username,
              kind,
              accessMode: 'forwarded_post',
              isBotAdmin: false,
              originNote: 'Forwarded post',
            });
            if (channel.username) {
              void this.syncUserbotSourceJoin(channel.username);
            }
            await ctx.reply(reply.text, { reply_markup: toGrammyKeyboard(reply) });
            return;
          }
        }

        // Handle commands & text inputs
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (text) {
          const reply = handleTextCommand(sessionKey, text);
          await ctx.reply(reply.text, { reply_markup: toGrammyKeyboard(reply) });
        }
      });

      // 3. Live channel_post listener (when bot is in a channel)
      bot.on('channel_post', async (ctx) => {
        const msg = ctx.channelPost as Record<string, any>;
        const classified = classifyGrammyMessage(msg);
        rateLimitQueue.handleIncomingMessage({
          id: `ch_${crypto.randomBytes(5).toString('hex')}`,
          sourceTelegramChatId: String(ctx.chat.id),
          sourceTitle: 'title' in ctx.chat && ctx.chat.title ? ctx.chat.title : String(ctx.chat.id),
          messageId: msg.message_id,
          ...classified,
          via: 'bot_api',
          rawForwardRef: {
            fromChatId: String(ctx.chat.id),
            messageId: msg.message_id,
          },
        });
      });

      // 4. Inline keyboard callbacks
      bot.on('callback_query:data', async (ctx) => {
        if (!isAuthorized(ctx.from?.id)) {
          await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
          return;
        }
        const sessionKey = `tg_${ctx.from.id}`;
        const reply = handleCallbackAction(sessionKey, ctx.callbackQuery.data);
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(reply.text, {
            reply_markup: toGrammyKeyboard(reply),
          });
        } catch {
          await ctx.reply(reply.text, {
            reply_markup: toGrammyKeyboard(reply),
          });
        }
      });

      // Self-healing error boundary: never crash the bot on transient Telegram API glitches
      bot.catch((err) => {
        this.lastError = err.message;
        console.error('[BotAPI] Caught runtime error (bot remains active):', err.message);
      });

      const me = await bot.api.getMe();
      this.botUsername = me.username;
      this.botRunning = true;

      // Start long polling in background with auto-restart watchdog
      void bot.start({
        allowed_updates: ['message', 'channel_post', 'callback_query', 'my_chat_member'],
        onStart: () => {
          this.botRunning = true;
          this.lastError = undefined;
          console.log(`[BotAPI] Live Telegram bot @${me.username} is running.`);
        },
      }).catch((err) => {
        this.botRunning = false;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.scheduleBotReconnect();
      });
    } catch (err) {
      this.botRunning = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[BotAPI] Failed to start:', this.lastError);
    }
  }

  private scheduleBotReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startBotApi();
    }, 10_000);
  }

  private async startUserbot(): Promise<void> {
    const apiIdRaw = process.env.TELEGRAM_API_ID?.trim();
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    const sessionStr = process.env.TELEGRAM_USERBOT_SESSION?.trim();

    if (!apiIdRaw || !apiHash || !sessionStr) {
      return;
    }

    const apiId = Number(apiIdRaw);
    if (!Number.isInteger(apiId) || apiId <= 0) {
      this.lastError = 'TELEGRAM_API_ID must be a valid positive integer';
      return;
    }

    try {
      const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
        connectionRetries: 5,
      });

      await client.connect();
      const me = (await client.getMe()) as { username?: string; firstName?: string };
      this.userbot = client;
      this.userbotRunning = true;
      this.userbotAccount = me.username ? `@${me.username}` : me.firstName ?? 'Userbot';

      // Listen to all incoming posts across every open/joined channel & group in real time
      client.addEventHandler(async (event: NewMessageEvent) => {
        try {
          const message = event.message;
          const chatId = event.chatId ? String(event.chatId) : '';
          if (!chatId) return;

          // Match against saved source channels by numeric ID or -100 prefix
          const normalizedIds = [chatId, chatId.startsWith('-100') ? chatId : `-100${chatId.replace(/^-/, '')}`];
          let matchedSourceId: string | null = null;
          for (const candidate of normalizedIds) {
            if (store.getConnectionsBySourceTelegramId(candidate).length > 0) {
              matchedSourceId = candidate;
              break;
            }
          }
          if (!matchedSourceId) return;

          let mediaType: MediaType = 'text';
          let fileName: string | undefined;
          let fileSizeMb: number | undefined;
          let fileUniqueId: string | undefined;

          if (message.video) {
            mediaType = 'video';
            fileSizeMb = message.file?.size ? Number(message.file.size) / (1024 * 1024) : undefined;
            fileName = message.file?.name ?? 'video.mp4';
            fileUniqueId = String(message.id);
          } else if (message.gif) {
            mediaType = 'animation';
            fileName = message.file?.name ?? 'animation.mp4';
          } else if (message.photo) {
            mediaType = 'photo';
          } else if (message.audio) {
            mediaType = 'audio';
            fileName = message.file?.name ?? 'audio.mp3';
          } else if (message.voice) {
            mediaType = 'voice';
          } else if (message.sticker) {
            mediaType = 'sticker';
          } else if (message.document) {
            mediaType = 'document';
            fileName = message.file?.name ?? 'file';
            fileSizeMb = message.file?.size ? Number(message.file.size) / (1024 * 1024) : undefined;
          } else if (message.poll) {
            mediaType = 'poll';
          }

          const payload: IncomingMessagePayload = {
            id: `ub_${crypto.randomBytes(5).toString('hex')}`,
            sourceTelegramChatId: matchedSourceId,
            sourceTitle: store.getChannelByTelegramId(matchedSourceId)?.title ?? matchedSourceId,
            messageId: message.id,
            mediaType,
            caption: mediaType !== 'text' ? message.message : undefined,
            text: mediaType === 'text' ? message.message : undefined,
            fileName,
            fileSizeMb,
            fileUniqueId,
            via: 'userbot_mtproto',
            rawForwardRef: {
              fromChatId: matchedSourceId,
              messageId: message.id,
            },
          };

          rateLimitQueue.handleIncomingMessage(payload);
        } catch (err) {
          console.error('[Userbot] Event handler error:', err);
        }
      }, new NewMessage({}));

      console.log(`[Userbot] Live MTProto Userbot (${this.userbotAccount}) connected.`);
    } catch (err) {
      this.userbotRunning = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[Userbot] Failed to connect:', this.lastError);
    }
  }
}

export const telegramEngine = new TelegramEngine();
