import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { evaluateFilters } from './filterEngine.ts';
import { store } from './store.ts';
import type {
  Connection,
  DeliveryLog,
  IncomingMessagePayload,
  QueueSnapshot,
  SavedChannel,
} from './types.ts';

export type TransportExecutor = (params: {
  connection: Connection;
  source: SavedChannel;
  destination: SavedChannel;
  payload: IncomingMessagePayload;
  transformedCaption: string;
  mode: 'copy' | 'forward';
}) => Promise<{
  transport: 'userbot' | 'bot_api' | 'simulation';
  detail: string;
}>;

export class FloodWaitError extends Error {
  public readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message?: string) {
    super(message ?? `Telegram FLOOD_WAIT for ${retryAfterSeconds}s`);
    this.name = 'FloodWaitError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

interface QueuedTask {
  id: string;
  connectionId: string;
  source: SavedChannel;
  target: SavedChannel;
  backup: SavedChannel | null;
  payload: IncomingMessagePayload;
  transformedCaption: string;
  mode: 'copy' | 'forward';
  enqueuedAt: number;
  readyAt: number;
  attempts: number;
  isBackupDispatch: boolean;
}

class RateLimitQueueManager extends EventEmitter {
  private queue: QueuedTask[] = [];
  private processingCount = 0;
  private globalSentTimestamps: number[] = [];
  private perChatSecondTimestamps = new Map<string, number[]>();
  private perChatMinuteTimestamps = new Map<string, number[]>();
  private chatFloodWaitUntil = new Map<string, { until: number; title: string }>();
  private totalProcessed = 0;
  private totalRateLimited = 0;
  private totalErrors = 0;
  private executor: TransportExecutor | null = null;
  private pumpInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.pumpInterval = setInterval(() => {
      void this.pump();
    }, 100);
  }

  public setExecutor(fn: TransportExecutor): void {
    this.executor = fn;
  }

  public getSnapshot(): QueueSnapshot {
    const now = Date.now();
    const cfg = store.getRateLimitConfig();
    this.pruneTimestamps(now);

    const activeFloodWaits: QueueSnapshot['activeFloodWaits'] = [];
    for (const [chatId, entry] of this.chatFloodWaitUntil.entries()) {
      if (entry.until > now) {
        activeFloodWaits.push({
          chatId,
          chatTitle: entry.title,
          unlockAt: new Date(entry.until).toISOString(),
          remainingSeconds: Math.ceil((entry.until - now) / 1000),
        });
      } else {
        this.chatFloodWaitUntil.delete(chatId);
      }
    }

    return {
      pendingCount: this.queue.length,
      processingCount: this.processingCount,
      globalTokensAvailable: Math.max(0, cfg.globalMaxPerSecond - this.globalSentTimestamps.length),
      globalMaxPerSecond: cfg.globalMaxPerSecond,
      activeFloodWaits,
      totalProcessed: this.totalProcessed,
      totalRateLimited: this.totalRateLimited,
      totalErrors: this.totalErrors,
    };
  }

  public triggerSimulatedFloodWait(chatId: string, chatTitle: string, seconds: number): void {
    const bounded = Math.min(60, Math.max(2, Math.round(seconds)));
    this.chatFloodWaitUntil.set(chatId, {
      until: Date.now() + bounded * 1000,
      title: chatTitle,
    });
    this.totalRateLimited += 1;
    this.emit('update', { type: 'queue', snapshot: this.getSnapshot() });
  }

  public handleIncomingMessage(payload: IncomingMessagePayload): {
    matchedConnections: number;
    queuedTasks: number;
    filteredOut: number;
  } {
    const connections = store.getConnectionsBySourceTelegramId(payload.sourceTelegramChatId);
    let queuedTasks = 0;
    let filteredOut = 0;

    for (const conn of connections) {
      const source = store.getChannelById(conn.sourceChannelId);
      const target = store.getChannelById(conn.targetChannelId);
      if (!source || !target) continue;
      const backup = conn.backupChannelId ? store.getChannelById(conn.backupChannelId) ?? null : null;

      const evalResult = evaluateFilters(conn.id, conn.filters, payload);
      if (!evalResult.allowed) {
        filteredOut += 1;
        store.recordConnectionStat(conn.id, 'filtered');
        const log: DeliveryLog = {
          id: `log_${crypto.randomBytes(5).toString('hex')}`,
          timestamp: new Date().toISOString(),
          connectionId: conn.id,
          connectionName: conn.name,
          sourceTitle: source.title,
          targetTitle: target.title,
          backupTitle: backup?.title,
          mediaType: payload.mediaType,
          fileName: payload.fileName,
          fileSizeMb: payload.fileSizeMb,
          captionPreview: (payload.caption ?? payload.text ?? '').slice(0, 100),
          transport: payload.via === 'userbot_mtproto' ? 'userbot' : payload.via === 'bot_api' ? 'bot_api' : 'simulation',
          status: 'filtered',
          detail: evalResult.reason ?? 'Filtered out by connection rules',
          latencyMs: 0,
        };
        store.appendLog(log);
        this.emit('update', { type: 'log', log, snapshot: this.getSnapshot() });
        continue;
      }

      const now = Date.now();
      const delayMs = Math.max(0, conn.filters.delaySeconds * 1000);

      // Enqueue primary target delivery
      this.queue.push({
        id: `task_${crypto.randomBytes(5).toString('hex')}`,
        connectionId: conn.id,
        source,
        target,
        backup,
        payload,
        transformedCaption: evalResult.transformedCaption,
        mode: evalResult.mode,
        enqueuedAt: now,
        readyAt: now + delayMs,
        attempts: 0,
        isBackupDispatch: false,
      });
      queuedTasks += 1;

      // If backup mode is 'mirror' and a backup channel is attached, queue dual delivery
      if (backup && conn.filters.backupMode === 'mirror') {
        this.queue.push({
          id: `task_${crypto.randomBytes(5).toString('hex')}`,
          connectionId: conn.id,
          source,
          target: backup,
          backup: null,
          payload,
          transformedCaption: evalResult.transformedCaption,
          mode: evalResult.mode,
          enqueuedAt: now,
          readyAt: now + delayMs + 250,
          attempts: 0,
          isBackupDispatch: true,
        });
        queuedTasks += 1;
      }
    }

    if (queuedTasks > 0) {
      this.emit('update', { type: 'queue', snapshot: this.getSnapshot() });
      void this.pump();
    }

    return {
      matchedConnections: connections.length,
      queuedTasks,
      filteredOut,
    };
  }

  private pruneTimestamps(now: number): void {
    const secCutoff = now - 1000;
    const minCutoff = now - 60_000;

    while (this.globalSentTimestamps.length > 0 && this.globalSentTimestamps[0] < secCutoff) {
      this.globalSentTimestamps.shift();
    }
    for (const [chatId, arr] of this.perChatSecondTimestamps.entries()) {
      const next = arr.filter((t) => t >= secCutoff);
      if (next.length === 0) this.perChatSecondTimestamps.delete(chatId);
      else this.perChatSecondTimestamps.set(chatId, next);
    }
    for (const [chatId, arr] of this.perChatMinuteTimestamps.entries()) {
      const next = arr.filter((t) => t >= minCutoff);
      if (next.length === 0) this.perChatMinuteTimestamps.delete(chatId);
      else this.perChatMinuteTimestamps.set(chatId, next);
    }
  }

  private canDispatchToChat(chatId: string, now: number): boolean {
    const cfg = store.getRateLimitConfig();
    if (this.globalSentTimestamps.length >= cfg.globalMaxPerSecond) {
      return false;
    }

    const flood = this.chatFloodWaitUntil.get(chatId);
    if (flood && flood.until > now) {
      return false;
    }

    const secList = this.perChatSecondTimestamps.get(chatId) ?? [];
    if (secList.length >= cfg.perChatMaxPerSecond) {
      return false;
    }

    const minList = this.perChatMinuteTimestamps.get(chatId) ?? [];
    if (minList.length >= cfg.perChatMaxPerMinute) {
      return false;
    }

    return true;
  }

  private recordDispatchSlot(chatId: string, now: number): void {
    this.globalSentTimestamps.push(now);

    const secList = this.perChatSecondTimestamps.get(chatId) ?? [];
    secList.push(now);
    this.perChatSecondTimestamps.set(chatId, secList);

    const minList = this.perChatMinuteTimestamps.get(chatId) ?? [];
    minList.push(now);
    this.perChatMinuteTimestamps.set(chatId, minList);
  }

  private async pump(): Promise<void> {
    if (this.queue.length === 0) return;
    const now = Date.now();
    this.pruneTimestamps(now);

    // Find next ready task whose target chat has rate-limit budget
    let dispatchedAny = false;
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.readyAt > now) continue;
      if (!this.canDispatchToChat(task.target.telegramChatId, now)) continue;

      this.queue.splice(i, 1);
      i--;
      this.recordDispatchSlot(task.target.telegramChatId, now);
      dispatchedAny = true;
      void this.executeTask(task);

      // Keep concurrency bounded smoothly
      if (this.processingCount >= 8) break;
    }

    if (dispatchedAny) {
      this.emit('update', { type: 'queue', snapshot: this.getSnapshot() });
    }
  }

  private async executeTask(task: QueuedTask): Promise<void> {
    this.processingCount += 1;
    task.attempts += 1;
    const startMs = Date.now();
    const cfg = store.getRateLimitConfig();
    const conn = store.getConnectionById(task.connectionId);

    try {
      if (!conn) {
        return;
      }

      const result = this.executor
        ? await this.executor({
            connection: conn,
            source: task.source,
            destination: task.target,
            payload: task.payload,
            transformedCaption: task.transformedCaption,
            mode: task.mode,
          })
        : {
            transport: 'simulation' as const,
            detail: `Delivered via ${conn.filters.preferUserbot ? 'Userbot MTProto' : 'Bot API'} (${task.mode})`,
          };

      this.totalProcessed += 1;
      if (task.isBackupDispatch) {
        store.recordConnectionStat(conn.id, 'backup');
      } else {
        store.recordConnectionStat(conn.id, 'forwarded');
      }

      const log: DeliveryLog = {
        id: `log_${crypto.randomBytes(5).toString('hex')}`,
        timestamp: new Date().toISOString(),
        connectionId: conn.id,
        connectionName: conn.name,
        sourceTitle: task.source.title,
        targetTitle: task.target.title,
        backupTitle: task.backup?.title,
        mediaType: task.payload.mediaType,
        fileName: task.payload.fileName,
        fileSizeMb: task.payload.fileSizeMb,
        captionPreview: task.transformedCaption.slice(0, 100),
        transport: result.transport,
        status: task.isBackupDispatch ? 'backup_delivered' : 'delivered',
        detail: result.detail,
        latencyMs: Date.now() - task.enqueuedAt,
      };
      store.appendLog(log);
      this.emit('update', { type: 'log', log, snapshot: this.getSnapshot() });
    } catch (err) {
      const connRef = store.getConnectionById(task.connectionId);
      if (err instanceof FloodWaitError && cfg.autoFloodBackoff) {
        this.totalRateLimited += 1;
        const waitMs = (err.retryAfterSeconds + 1) * 1000;
        this.chatFloodWaitUntil.set(task.target.telegramChatId, {
          until: Date.now() + waitMs,
          title: task.target.title,
        });
        // Re-enqueue task without dropping it
        task.readyAt = Date.now() + waitMs;
        this.queue.push(task);

        const log: DeliveryLog = {
          id: `log_${crypto.randomBytes(5).toString('hex')}`,
          timestamp: new Date().toISOString(),
          connectionId: task.connectionId,
          connectionName: connRef?.name ?? 'Connection',
          sourceTitle: task.source.title,
          targetTitle: task.target.title,
          mediaType: task.payload.mediaType,
          fileName: task.payload.fileName,
          fileSizeMb: task.payload.fileSizeMb,
          captionPreview: task.transformedCaption.slice(0, 100),
          transport: 'userbot',
          status: 'rate_limited',
          detail: `FLOOD_WAIT ${err.retryAfterSeconds}s — auto-requeued cleanly`,
          latencyMs: Date.now() - startMs,
        };
        store.appendLog(log);
        this.emit('update', { type: 'log', log, snapshot: this.getSnapshot() });
      } else if (task.attempts <= cfg.maxRetries) {
        // Exponential backoff retry
        task.readyAt = Date.now() + task.attempts * 1500;
        this.queue.push(task);
      } else {
        this.totalErrors += 1;
        if (connRef) {
          store.recordConnectionStat(connRef.id, 'error');
        }

        // Failover to backup channel if configured
        if (!task.isBackupDispatch && task.backup && connRef && connRef.filters.backupMode === 'failover') {
          this.queue.push({
            ...task,
            id: `task_${crypto.randomBytes(5).toString('hex')}`,
            target: task.backup,
            backup: null,
            attempts: 0,
            readyAt: Date.now() + 200,
            isBackupDispatch: true,
          });
        }

        const errMsg = err instanceof Error ? err.message : 'Unknown forwarding error';
        const log: DeliveryLog = {
          id: `log_${crypto.randomBytes(5).toString('hex')}`,
          timestamp: new Date().toISOString(),
          connectionId: task.connectionId,
          connectionName: connRef?.name ?? 'Connection',
          sourceTitle: task.source.title,
          targetTitle: task.target.title,
          backupTitle: task.backup?.title,
          mediaType: task.payload.mediaType,
          fileName: task.payload.fileName,
          fileSizeMb: task.payload.fileSizeMb,
          captionPreview: task.transformedCaption.slice(0, 100),
          transport: 'bot_api',
          status: 'failed',
          detail: `${errMsg}${task.backup && connRef?.filters.backupMode === 'failover' ? ' — failing over to backup channel' : ''}`,
          latencyMs: Date.now() - startMs,
        };
        store.appendLog(log);
        this.emit('update', { type: 'log', log, snapshot: this.getSnapshot() });
      }
    } finally {
      this.processingCount = Math.max(0, this.processingCount - 1);
      this.emit('update', { type: 'queue', snapshot: this.getSnapshot() });
    }
  }

  public stop(): void {
    if (this.pumpInterval) {
      clearInterval(this.pumpInterval);
      this.pumpInterval = null;
    }
  }
}

export const rateLimitQueue = new RateLimitQueueManager();
