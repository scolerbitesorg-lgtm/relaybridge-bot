import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type BotChatMessage,
  type ChannelAccessMode,
  type ChannelRole,
  type ChatKind,
  type Connection,
  type ConnectionFilterSettings,
  createDefaultFilterSettings,
  type DatabaseSchema,
  type DeliveryLog,
  type RateLimitConfig,
  type SavedChannel,
} from './types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.resolve(DATA_DIR, 'relaybridge.json');

if (!DATA_FILE.startsWith(DATA_DIR + path.sep)) {
  throw new Error('Invalid persistence path configuration');
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  globalMaxPerSecond: 25,
  perChatMaxPerSecond: 1,
  perChatMaxPerMinute: 18,
  maxRetries: 3,
  autoFloodBackoff: true,
};

const MAX_LOGS = 250;
const MAX_PLAYGROUND_HISTORY = 80;

class Store {
  private data: DatabaseSchema;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): DatabaseSchema {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Partial<DatabaseSchema>;
        return {
          channels: Array.isArray(parsed.channels) ? parsed.channels : [],
          connections: Array.isArray(parsed.connections) ? parsed.connections : [],
          logs: Array.isArray(parsed.logs) ? parsed.logs : [],
          rateLimit: { ...DEFAULT_RATE_LIMIT, ...(parsed.rateLimit ?? {}) },
          playgroundHistory: Array.isArray(parsed.playgroundHistory)
            ? parsed.playgroundHistory
            : [],
        };
      }
    } catch (err) {
      console.error('[Store] Failed to load existing data file, initializing fresh state:', err);
    }

    return {
      channels: [],
      connections: [],
      logs: [],
      rateLimit: { ...DEFAULT_RATE_LIMIT },
      playgroundHistory: [],
    };
  }

  private schedulePersist(): void {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistSync();
    }, 120);
  }

  private persistSync(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpPath = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, DATA_FILE);
    } catch (err) {
      console.error('[Store] Persist error:', err);
    }
  }

  public getChannels(): SavedChannel[] {
    return this.data.channels;
  }

  public getChannelById(id: string): SavedChannel | undefined {
    return this.data.channels.find((c) => c.id === id);
  }

  public getChannelByTelegramId(telegramChatId: string): SavedChannel | undefined {
    const normalized = String(telegramChatId).trim().toLowerCase();
    return this.data.channels.find(
      (c) =>
        c.telegramChatId.toLowerCase() === normalized ||
        (c.username && `@${c.username.toLowerCase()}` === normalized) ||
        (c.username && c.username.toLowerCase() === normalized),
    );
  }

  public upsertChannel(input: {
    telegramChatId: string;
    title: string;
    username?: string;
    kind: ChatKind;
    role: ChannelRole;
    accessMode: ChannelAccessMode;
    isBotAdmin?: boolean;
    userbotJoined?: boolean;
    memberCount?: number;
  }): SavedChannel {
    const cleanId = String(input.telegramChatId).trim();
    const cleanUsername = input.username
      ? input.username.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').trim()
      : undefined;

    const existing = this.data.channels.find(
      (c) =>
        c.telegramChatId === cleanId ||
        (cleanUsername && c.username?.toLowerCase() === cleanUsername.toLowerCase()),
    );

    if (existing) {
      existing.title = input.title.trim() || existing.title;
      if (cleanUsername) existing.username = cleanUsername;
      existing.kind = input.kind;
      if (input.role !== 'unassigned' || existing.role === 'unassigned') {
        existing.role = input.role;
      }
      existing.accessMode = input.accessMode;
      if (typeof input.isBotAdmin === 'boolean') existing.isBotAdmin = input.isBotAdmin;
      if (typeof input.userbotJoined === 'boolean') existing.userbotJoined = input.userbotJoined;
      if (typeof input.memberCount === 'number') existing.memberCount = input.memberCount;
      existing.lastActivityAt = new Date().toISOString();
      this.schedulePersist();
      return existing;
    }

    const created: SavedChannel = {
      id: `ch_${crypto.randomBytes(6).toString('hex')}`,
      telegramChatId: cleanId,
      title: input.title.trim() || cleanId,
      username: cleanUsername || undefined,
      kind: input.kind,
      role: input.role,
      accessMode: input.accessMode,
      isBotAdmin: Boolean(input.isBotAdmin),
      userbotJoined: Boolean(input.userbotJoined),
      memberCount: input.memberCount,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.data.channels.unshift(created);
    this.schedulePersist();
    return created;
  }

  public updateChannel(
    id: string,
    patch: Partial<Pick<SavedChannel, 'title' | 'username' | 'kind' | 'role' | 'accessMode' | 'isBotAdmin' | 'userbotJoined'>>,
  ): SavedChannel | null {
    const channel = this.getChannelById(id);
    if (!channel) return null;
    Object.assign(channel, patch);
    channel.lastActivityAt = new Date().toISOString();
    this.schedulePersist();
    return channel;
  }

  public deleteChannel(id: string): boolean {
    const idx = this.data.channels.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.data.channels.splice(idx, 1);
    // Clean up connections that referenced this channel
    this.data.connections = this.data.connections.filter(
      (conn) => conn.sourceChannelId !== id && conn.targetChannelId !== id,
    );
    for (const conn of this.data.connections) {
      if (conn.backupChannelId === id) {
        conn.backupChannelId = null;
      }
    }
    this.schedulePersist();
    return true;
  }

  public getConnections(): Connection[] {
    return this.data.connections;
  }

  public getConnectionById(id: string): Connection | undefined {
    return this.data.connections.find((c) => c.id === id);
  }

  public getConnectionsBySourceTelegramId(sourceTelegramChatId: string): Connection[] {
    const sourceChannel = this.getChannelByTelegramId(sourceTelegramChatId);
    if (!sourceChannel) return [];
    return this.data.connections.filter(
      (c) => c.enabled && c.sourceChannelId === sourceChannel.id,
    );
  }

  public createConnection(input: {
    name?: string;
    sourceChannelId: string;
    targetChannelId: string;
    backupChannelId?: string | null;
    filters?: Partial<ConnectionFilterSettings>;
  }): Connection | null {
    const source = this.getChannelById(input.sourceChannelId);
    const target = this.getChannelById(input.targetChannelId);
    if (!source || !target || source.id === target.id) {
      return null;
    }

    const backup = input.backupChannelId ? this.getChannelById(input.backupChannelId) : null;

    const defaults = createDefaultFilterSettings();
    const mergedFilters: ConnectionFilterSettings = {
      ...defaults,
      ...(input.filters ?? {}),
      allowedMedia: {
        ...defaults.allowedMedia,
        ...(input.filters?.allowedMedia ?? {}),
      },
    };

    const now = new Date().toISOString();
    const conn: Connection = {
      id: `conn_${crypto.randomBytes(6).toString('hex')}`,
      name: input.name?.trim() || `${source.title} → ${target.title}`,
      sourceChannelId: source.id,
      targetChannelId: target.id,
      backupChannelId: backup && backup.id !== source.id && backup.id !== target.id ? backup.id : null,
      enabled: true,
      filters: mergedFilters,
      stats: {
        forwardedCount: 0,
        filteredOutCount: 0,
        backupCount: 0,
        errorCount: 0,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.data.connections.unshift(conn);
    this.schedulePersist();
    return conn;
  }

  public updateConnection(
    id: string,
    patch: Partial<{
      name: string;
      sourceChannelId: string;
      targetChannelId: string;
      backupChannelId: string | null;
      enabled: boolean;
      filters: Partial<ConnectionFilterSettings>;
    }>,
  ): Connection | null {
    const conn = this.getConnectionById(id);
    if (!conn) return null;

    if (typeof patch.name === 'string' && patch.name.trim()) {
      conn.name = patch.name.trim();
    }
    if (typeof patch.sourceChannelId === 'string' && this.getChannelById(patch.sourceChannelId)) {
      conn.sourceChannelId = patch.sourceChannelId;
    }
    if (typeof patch.targetChannelId === 'string' && this.getChannelById(patch.targetChannelId)) {
      conn.targetChannelId = patch.targetChannelId;
    }
    if (patch.backupChannelId === null) {
      conn.backupChannelId = null;
    } else if (typeof patch.backupChannelId === 'string' && this.getChannelById(patch.backupChannelId)) {
      conn.backupChannelId = patch.backupChannelId;
    }
    if (typeof patch.enabled === 'boolean') {
      conn.enabled = patch.enabled;
    }
    if (patch.filters) {
      conn.filters = {
        ...conn.filters,
        ...patch.filters,
        allowedMedia: {
          ...conn.filters.allowedMedia,
          ...(patch.filters.allowedMedia ?? {}),
        },
      };
    }

    conn.updatedAt = new Date().toISOString();
    this.schedulePersist();
    return conn;
  }

  public recordConnectionStat(
    connectionId: string,
    kind: 'forwarded' | 'filtered' | 'backup' | 'error',
  ): void {
    const conn = this.getConnectionById(connectionId);
    if (!conn) return;
    if (kind === 'forwarded') {
      conn.stats.forwardedCount += 1;
      conn.stats.lastForwardedAt = new Date().toISOString();
    } else if (kind === 'filtered') {
      conn.stats.filteredOutCount += 1;
    } else if (kind === 'backup') {
      conn.stats.backupCount += 1;
    } else if (kind === 'error') {
      conn.stats.errorCount += 1;
    }
    this.schedulePersist();
  }

  public deleteConnection(id: string): boolean {
    const idx = this.data.connections.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.data.connections.splice(idx, 1);
    this.schedulePersist();
    return true;
  }

  public getLogs(): DeliveryLog[] {
    return this.data.logs;
  }

  public appendLog(log: DeliveryLog): void {
    this.data.logs.unshift(log);
    if (this.data.logs.length > MAX_LOGS) {
      this.data.logs.length = MAX_LOGS;
    }
    this.schedulePersist();
  }

  public clearLogs(): void {
    this.data.logs = [];
    this.schedulePersist();
  }

  public getRateLimitConfig(): RateLimitConfig {
    return this.data.rateLimit;
  }

  public updateRateLimitConfig(patch: Partial<RateLimitConfig>): RateLimitConfig {
    const clamp = (val: unknown, fallback: number, min: number, max: number) => {
      const n = Number(val);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    this.data.rateLimit = {
      globalMaxPerSecond: clamp(patch.globalMaxPerSecond, this.data.rateLimit.globalMaxPerSecond, 1, 30),
      perChatMaxPerSecond: clamp(patch.perChatMaxPerSecond, this.data.rateLimit.perChatMaxPerSecond, 1, 5),
      perChatMaxPerMinute: clamp(patch.perChatMaxPerMinute, this.data.rateLimit.perChatMaxPerMinute, 1, 60),
      maxRetries: clamp(patch.maxRetries, this.data.rateLimit.maxRetries, 0, 10),
      autoFloodBackoff:
        typeof patch.autoFloodBackoff === 'boolean'
          ? patch.autoFloodBackoff
          : this.data.rateLimit.autoFloodBackoff,
    };
    this.schedulePersist();
    return this.data.rateLimit;
  }

  public getPlaygroundHistory(): BotChatMessage[] {
    return this.data.playgroundHistory;
  }

  public appendPlaygroundMessage(msg: BotChatMessage): void {
    this.data.playgroundHistory.push(msg);
    if (this.data.playgroundHistory.length > MAX_PLAYGROUND_HISTORY) {
      this.data.playgroundHistory = this.data.playgroundHistory.slice(-MAX_PLAYGROUND_HISTORY);
    }
    this.schedulePersist();
  }

  public clearPlaygroundHistory(): void {
    this.data.playgroundHistory = [];
    this.schedulePersist();
  }
}

export const store = new Store();
