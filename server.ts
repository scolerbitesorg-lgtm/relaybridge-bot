import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  BOT_MENU_COMMANDS,
  buildStartReply,
  handleCallbackAction,
  handleForwardedChannelDiscovery,
  handleTextCommand,
} from './server/botCommander.ts';
import { generateStandaloneExport } from './server/codeExporter.ts';
import { rateLimitQueue } from './server/rateLimiter.ts';
import { store } from './server/store.ts';
import { telegramEngine } from './server/telegramEngine.ts';
import type {
  BotChatMessage,
  ChannelAccessMode,
  ChannelRole,
  ChatKind,
  MediaType,
} from './server/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = crypto.randomBytes(32);
const activeSessions = new Set<string>();

const VALID_ROLES = new Set<ChannelRole>(['source', 'target', 'backup', 'unassigned']);
const VALID_KINDS = new Set<ChatKind>(['channel', 'supergroup', 'group']);
const VALID_ACCESS_MODES = new Set<ChannelAccessMode>([
  'bot_admin',
  'userbot_open',
  'forwarded_post',
  'manual_link',
]);
const VALID_MEDIA_TYPES = new Set<MediaType>([
  'video',
  'document',
  'photo',
  'audio',
  'voice',
  'animation',
  'sticker',
  'text',
  'poll',
]);

function isPasscodeConfigured(): boolean {
  return Boolean(process.env.DASHBOARD_PASSCODE?.trim());
}

function verifyPasscode(candidate: string): boolean {
  const configured = process.env.DASHBOARD_PASSCODE?.trim();
  if (!configured) return true;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

function createSessionToken(): string {
  const nonce = crypto.randomBytes(24).toString('hex');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(nonce).digest('hex');
  const token = `${nonce}.${sig}`;
  activeSessions.add(token);
  return token;
}

function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isPasscodeConfigured()) {
    next();
    return;
  }
  const authHeader = req.header('authorization') ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const token = bearer || queryToken;
  if (!token || !activeSessions.has(token)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function makeBotMsg(
  sender: 'user' | 'bot',
  text: string,
  extra?: Partial<BotChatMessage>,
): BotChatMessage {
  return {
    id: `msg_${crypto.randomBytes(5).toString('hex')}`,
    sender,
    timestamp: new Date().toISOString(),
    text,
    ...extra,
  };
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Public lightweight health check for Cloud Run & 24/7 uptime monitors (never exposes secrets)
  const healthHandler = (_req: Request, res: Response) => {
    const status = telegramEngine.getStatus();
    res.json({
      ok: true,
      botApiConfigured: status.botApiConfigured,
      botApiRunning: status.botApiRunning,
      userbotConfigured: status.userbotConfigured,
      userbotRunning: status.userbotRunning,
      uptimeSeconds: status.uptimeSeconds,
    });
  };
  app.get('/health', healthHandler);
  app.get('/healthz', healthHandler);

  // Auth status & login (only enforced when DASHBOARD_PASSCODE is configured in process.env)
  app.get('/api/auth/status', (_req, res) => {
    res.json({ passcodeProtected: isPasscodeConfigured() });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isPasscodeConfigured()) {
      res.json({ token: 'open', passcodeProtected: false });
      return;
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!verifyPasscode(passcode)) {
      res.status(401).json({ error: 'Invalid passcode' });
      return;
    }
    res.json({ token: createSessionToken(), passcodeProtected: true });
  });

  // Protect all operational API endpoints when DASHBOARD_PASSCODE is set
  app.use('/api', (req, res, next) => {
    if (req.path === '/auth/status' || req.path === '/auth/login') {
      next();
      return;
    }
    requireDashboardAuth(req, res, next);
  });

  app.post('/api/engine/restart', async (_req, res) => {
    const engine = await telegramEngine.restart();
    res.json({ engine });
  });

  // Bootstrap complete dashboard state
  app.get('/api/bootstrap', (_req, res) => {
    let history = store.getPlaygroundHistory();
    if (history.length === 0) {
      const welcome = buildStartReply();
      store.appendPlaygroundMessage(
        makeBotMsg('bot', welcome.text, { inlineKeyboard: welcome.inlineKeyboard }),
      );
      history = store.getPlaygroundHistory();
    }

    res.json({
      channels: store.getChannels(),
      connections: store.getConnections(),
      logs: store.getLogs(),
      rateLimit: store.getRateLimitConfig(),
      queue: rateLimitQueue.getSnapshot(),
      engine: telegramEngine.getStatus(),
      playgroundHistory: history,
      commands: BOT_MENU_COMMANDS,
    });
  });

  // Live SSE updates for queue depth, flood-wait timers, and delivery logs
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent({
      type: 'init',
      queue: rateLimitQueue.getSnapshot(),
      engine: telegramEngine.getStatus(),
    });

    const onUpdate = (evt: unknown) => {
      sendEvent(evt);
    };
    rateLimitQueue.on('update', onUpdate);

    const heartbeat = setInterval(() => {
      sendEvent({
        type: 'heartbeat',
        queue: rateLimitQueue.getSnapshot(),
        engine: telegramEngine.getStatus(),
      });
    }, 3000);

    req.on('close', () => {
      clearInterval(heartbeat);
      rateLimitQueue.off('update', onUpdate);
    });
  });

  // Channels CRUD
  app.post('/api/channels', (req, res) => {
    const rawId = typeof req.body?.telegramChatId === 'string' ? req.body.telegramChatId.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 64) : undefined;
    const kind: ChatKind = VALID_KINDS.has(req.body?.kind) ? req.body.kind : 'channel';
    const role: ChannelRole = VALID_ROLES.has(req.body?.role) ? req.body.role : 'source';
    const accessMode: ChannelAccessMode = VALID_ACCESS_MODES.has(req.body?.accessMode)
      ? req.body.accessMode
      : 'userbot_open';

    if (!rawId) {
      res.status(400).json({ error: 'Channel ID, @username, or t.me link is required' });
      return;
    }

    const cleanUsername =
      username ||
      (rawId.startsWith('@')
        ? rawId.slice(1)
        : rawId.includes('t.me/')
          ? rawId.split('t.me/')[1]?.split(/[/?#]/)[0]
          : undefined);

    const normalizedId = rawId.includes('t.me/') && cleanUsername ? `@${cleanUsername}` : rawId;

    const channel = store.upsertChannel({
      telegramChatId: normalizedId,
      title: title || (cleanUsername ? `@${cleanUsername}` : normalizedId),
      username: cleanUsername,
      kind,
      role,
      accessMode,
      isBotAdmin: Boolean(req.body?.isBotAdmin ?? accessMode === 'bot_admin'),
      userbotJoined: Boolean(req.body?.userbotJoined ?? (role === 'source' || accessMode === 'userbot_open')),
    });

    if (role === 'source' && cleanUsername) {
      void telegramEngine.syncUserbotSourceJoin(cleanUsername);
    }

    res.status(201).json({ channel, channels: store.getChannels() });
  });

  app.patch('/api/channels/:id', (req, res) => {
    const id = req.params.id;
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.title === 'string' && req.body.title.trim()) {
      patch.title = req.body.title.trim().slice(0, 120);
    }
    if (VALID_ROLES.has(req.body?.role)) {
      patch.role = req.body.role;
    }
    if (VALID_KINDS.has(req.body?.kind)) {
      patch.kind = req.body.kind;
    }
    if (VALID_ACCESS_MODES.has(req.body?.accessMode)) {
      patch.accessMode = req.body.accessMode;
    }
    if (typeof req.body?.isBotAdmin === 'boolean') {
      patch.isBotAdmin = req.body.isBotAdmin;
    }
    if (typeof req.body?.userbotJoined === 'boolean') {
      patch.userbotJoined = req.body.userbotJoined;
    }

    const updated = store.updateChannel(id, patch);
    if (!updated) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json({ channel: updated, channels: store.getChannels() });
  });

  app.delete('/api/channels/:id', (req, res) => {
    const ok = store.deleteChannel(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json({
      deleted: true,
      channels: store.getChannels(),
      connections: store.getConnections(),
    });
  });

  // Connections CRUD
  app.post('/api/connections', (req, res) => {
    const sourceChannelId = typeof req.body?.sourceChannelId === 'string' ? req.body.sourceChannelId : '';
    const targetChannelId = typeof req.body?.targetChannelId === 'string' ? req.body.targetChannelId : '';
    const backupChannelId =
      typeof req.body?.backupChannelId === 'string' && req.body.backupChannelId.trim()
        ? req.body.backupChannelId.trim()
        : null;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : undefined;

    const created = store.createConnection({
      name,
      sourceChannelId,
      targetChannelId,
      backupChannelId,
      filters: req.body?.filters,
    });

    if (!created) {
      res.status(400).json({ error: 'Valid distinct Source and Target channels are required' });
      return;
    }
    res.status(201).json({ connection: created, connections: store.getConnections() });
  });

  app.patch('/api/connections/:id', (req, res) => {
    const updated = store.updateConnection(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name.slice(0, 120) : undefined,
      sourceChannelId: typeof req.body?.sourceChannelId === 'string' ? req.body.sourceChannelId : undefined,
      targetChannelId: typeof req.body?.targetChannelId === 'string' ? req.body.targetChannelId : undefined,
      backupChannelId:
        req.body?.backupChannelId === null
          ? null
          : typeof req.body?.backupChannelId === 'string'
            ? req.body.backupChannelId
            : undefined,
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      filters: typeof req.body?.filters === 'object' && req.body.filters !== null ? req.body.filters : undefined,
    });

    if (!updated) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.json({ connection: updated, connections: store.getConnections() });
  });

  app.delete('/api/connections/:id', (req, res) => {
    const ok = store.deleteConnection(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.json({ deleted: true, connections: store.getConnections() });
  });

  // Rate Limit settings & FloodWait simulation
  app.patch('/api/rate-limit', (req, res) => {
    const updated = store.updateRateLimitConfig(req.body ?? {});
    res.json({ rateLimit: updated, queue: rateLimitQueue.getSnapshot() });
  });

  app.post('/api/rate-limit/simulate-flood', (req, res) => {
    const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
    const seconds = Number(req.body?.seconds ?? 8);
    const ch = store.getChannelById(channelId);
    if (!ch) {
      res.status(400).json({ error: 'Select a valid target channel' });
      return;
    }
    rateLimitQueue.triggerSimulatedFloodWait(ch.telegramChatId, ch.title, seconds);
    res.json({ queue: rateLimitQueue.getSnapshot() });
  });

  app.delete('/api/logs', (_req, res) => {
    store.clearLogs();
    res.json({ logs: [] });
  });

  // Dispatch a real test post (or burst) from a Source channel through FilterEngine + RateLimitQueue
  app.post('/api/dispatch/test', (req, res) => {
    const sourceChannelId = typeof req.body?.sourceChannelId === 'string' ? req.body.sourceChannelId : '';
    const source = store.getChannelById(sourceChannelId);
    if (!source) {
      res.status(400).json({ error: 'Select a valid Source channel first' });
      return;
    }

    const mediaType: MediaType = VALID_MEDIA_TYPES.has(req.body?.mediaType) ? req.body.mediaType : 'video';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.slice(0, 1024) : '';
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.slice(0, 120) : undefined;
    const fileSizeMb = Number.isFinite(Number(req.body?.fileSizeMb)) ? Math.max(0, Number(req.body.fileSizeMb)) : undefined;
    const burstCount = Math.min(10, Math.max(1, Math.round(Number(req.body?.burstCount ?? 1))));

    let matchedConnections = 0;
    let queuedTasks = 0;
    let filteredOut = 0;

    for (let i = 0; i < burstCount; i++) {
      const suffix = burstCount > 1 ? ` [Batch #${i + 1}/${burstCount}]` : '';
      const result = rateLimitQueue.handleIncomingMessage({
        id: `test_${crypto.randomBytes(5).toString('hex')}`,
        sourceTelegramChatId: source.telegramChatId,
        sourceTitle: source.title,
        messageId: Math.floor(10000 + Math.random() * 90000),
        mediaType,
        caption: mediaType !== 'text' ? (caption ? `${caption}${suffix}` : '') : undefined,
        text: mediaType === 'text' ? `${caption || 'Sample broadcast update'}${suffix}` : undefined,
        fileName:
          fileName ||
          (mediaType === 'video'
            ? `clip_${i + 1}.mp4`
            : mediaType === 'document'
              ? `archive_${i + 1}.pdf`
              : mediaType === 'audio'
                ? `track_${i + 1}.mp3`
                : undefined),
        fileSizeMb,
        fileUniqueId: req.body?.sameFileUniqueId ? 'fixed_dedupe_test_id' : undefined,
        via: 'playground',
      });
      matchedConnections = Math.max(matchedConnections, result.matchedConnections);
      queuedTasks += result.queuedTasks;
      filteredOut += result.filteredOut;
    }

    res.json({
      matchedConnections,
      queuedTasks,
      filteredOut,
      queue: rateLimitQueue.getSnapshot(),
      connections: store.getConnections(),
      logs: store.getLogs(),
    });
  });

  // Interactive Telegram Bot Playground endpoints (runs the exact same botCommander engine as live Telegram)
  app.post('/api/bot-playground/message', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 500) : '';
    if (!text) {
      res.status(400).json({ error: 'Message text is required' });
      return;
    }
    store.appendPlaygroundMessage(makeBotMsg('user', text));
    const reply = handleTextCommand('playground_owner', text);
    store.appendPlaygroundMessage(
      makeBotMsg('bot', reply.text, { inlineKeyboard: reply.inlineKeyboard }),
    );
    res.json({
      playgroundHistory: store.getPlaygroundHistory(),
      channels: store.getChannels(),
      connections: store.getConnections(),
    });
  });

  app.post('/api/bot-playground/forward', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '';
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().replace(/^@/, '').slice(0, 64) : undefined;
    const telegramChatId =
      typeof req.body?.telegramChatId === 'string' && req.body.telegramChatId.trim()
        ? req.body.telegramChatId.trim()
        : `-100${Math.floor(1000000000 + Math.random() * 8999999999)}`;
    const kind: ChatKind = VALID_KINDS.has(req.body?.kind) ? req.body.kind : 'channel';
    const postPreview =
      typeof req.body?.postPreview === 'string' && req.body.postPreview.trim()
        ? req.body.postPreview.trim().slice(0, 240)
        : 'Forwarded video post (1080p.mp4 — 48.2 MB)';

    if (!title) {
      res.status(400).json({ error: 'Channel title is required' });
      return;
    }

    store.appendPlaygroundMessage(
      makeBotMsg('user', postPreview, {
        forwardedFrom: {
          chatId: telegramChatId,
          title,
          username,
          kind,
        },
      }),
    );

    const { reply } = handleForwardedChannelDiscovery({
      telegramChatId,
      title,
      username,
      kind,
      accessMode: 'forwarded_post',
      isBotAdmin: false,
      originNote: 'Forwarded post',
    });

    store.appendPlaygroundMessage(
      makeBotMsg('bot', reply.text, { inlineKeyboard: reply.inlineKeyboard }),
    );

    res.json({
      playgroundHistory: store.getPlaygroundHistory(),
      channels: store.getChannels(),
      connections: store.getConnections(),
    });
  });

  app.post('/api/bot-playground/callback', (req, res) => {
    const callbackData = typeof req.body?.callbackData === 'string' ? req.body.callbackData.trim() : '';
    if (!callbackData) {
      res.status(400).json({ error: 'callbackData is required' });
      return;
    }
    const reply = handleCallbackAction('playground_owner', callbackData);
    store.appendPlaygroundMessage(
      makeBotMsg('bot', reply.text, { inlineKeyboard: reply.inlineKeyboard }),
    );
    res.json({
      playgroundHistory: store.getPlaygroundHistory(),
      channels: store.getChannels(),
      connections: store.getConnections(),
    });
  });

  app.delete('/api/bot-playground/history', (_req, res) => {
    store.clearPlaygroundHistory();
    const welcome = buildStartReply();
    store.appendPlaygroundMessage(
      makeBotMsg('bot', welcome.text, { inlineKeyboard: welcome.inlineKeyboard }),
    );
    res.json({ playgroundHistory: store.getPlaygroundHistory() });
  });

  // Standalone Bot + Userbot Deployment Bundle Export
  app.get('/api/export', (_req, res) => {
    res.json(generateStandaloneExport());
  });

  // Boot live Telegram Bot API + MTProto Userbot if secrets are present in process.env
  void telegramEngine.start();

  // Mount Vite middleware in development or static dist in production
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RelayBridge] Server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = async () => {
    rateLimitQueue.stop();
    await telegramEngine.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void startServer();
