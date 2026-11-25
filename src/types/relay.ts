export type ChannelRole = 'source' | 'target' | 'backup' | 'unassigned';

export type ChannelType = 'channel' | 'supergroup' | 'group';

export type AccessMode = 'bot_admin' | 'bot_member' | 'userbot_public' | 'forwarded_detect';

export interface SavedChannel {
  id: string;
  telegramChatId: string; // e.g. -1001928374650 or @channelusername
  title: string;
  username?: string;
  type: ChannelType;
  roles: ChannelRole[];
  accessMode: AccessMode;
  isPublicOpen: boolean;
  addedVia: 'bot_added' | 'forwarded_post' | 'manual_link' | 'userbot_sync';
  createdAt: string;
  lastActivityAt?: string;
}

export type MediaType =
  | 'video'
  | 'document'
  | 'photo'
  | 'audio'
  | 'voice'
  | 'animation'
  | 'sticker'
  | 'text'
  | 'poll';

export interface ReplaceRule {
  find: string;
  replace: string;
}

export interface ConnectionFilterSettings {
  allowedMedia: Record<MediaType, boolean>;
  onlyWithCaption: boolean; // e.g. Only Video with Caption / Files with Caption
  forwardMode: 'copy' | 'forward'; // copy removes "Forwarded from" header
  captionMode: 'keep' | 'strip' | 'custom_only';
  captionPrefix: string;
  captionSuffix: string;
  stripLinks: boolean;
  stripUsernames: boolean;
  replaceRules: ReplaceRule[];
  includeKeywords: string[];
  excludeKeywords: string[];
  minFileSizeMb: number;
  maxFileSizeMb: number; // 0 means unlimited (up to 4GB via userbot)
  deduplicate: boolean;
  delaySeconds: number;
  backupMode: 'off' | 'mirror' | 'failover';
  preferUserbot: boolean; // Use MTProto userbot for large files & open channels without admin
}

export interface Connection {
  id: string;
  name: string;
  sourceChannelId: string; // SavedChannel.id
  targetChannelId: string; // SavedChannel.id
  backupChannelId?: string | null; // optional SavedChannel.id
  active: boolean;
  settings: ConnectionFilterSettings;
  stats: {
    forwardedCount: number;
    filteredCount: number;
    failedCount: number;
    backupCount: number;
    lastForwardedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface IncomingMessagePayload {
  sourceChatId: string; // telegramChatId or SavedChannel.id
  sourceTitle?: string;
  messageId: number;
  mediaType: MediaType;
  caption?: string;
  text?: string;
  fileName?: string;
  fileSizeMb?: number;
  fileUniqueId?: string;
  origin: 'telegram_bot' | 'telegram_userbot' | 'playground_sim';
}

export type DeliveryStatus =
  | 'queued'
  | 'processing'
  | 'delivered'
  | 'filtered'
  | 'rate_limited'
  | 'retrying'
  | 'backup_delivered'
  | 'failed';

export interface DeliveryLog {
  id: string;
  connectionId: string;
  connectionName: string;
  sourceTitle: string;
  targetTitle: string;
  backupTitle?: string;
  mediaType: MediaType;
  fileName?: string;
  fileSizeMb?: number;
  previewText: string;
  status: DeliveryStatus;
  transport: 'userbot_mtproto' | 'bot_api' | 'simulation';
  detail: string;
  attempts: number;
  durationMs?: number;
  timestamp: string;
}

export interface RateLimitConfig {
  globalMaxPerSecond: number; // Telegram safe global default: 25
  perChatMaxPerSecond: number; // Telegram safe per-chat default: 1
  perChatMaxPerMinute: number; // Telegram group safe default: 18
  maxRetries: number;
  autoRecoverFloodWait: boolean;
}

export interface RateLimitSnapshot {
  config: RateLimitConfig;
  queuedCount: number;
  processingCount: number;
  globalTokensAvailable: number;
  globalSentLastSecond: number;
  activeCooldowns: Array<{
    chatId: string;
    chatTitle: string;
    remainingMs: number;
    reason: string;
  }>;
  totalProcessed: number;
  totalRateLimited: number;
  totalRecovered: number;
}

export interface EngineStatus {
  botApiConfigured: boolean;
  botApiRunning: boolean;
  botUsername?: string;
  botError?: string;
  userbotConfigured: boolean;
  userbotRunning: boolean;
  userbotPhoneOrUsername?: string;
  userbotError?: string;
  uptimeSeconds: number;
  authProtected: boolean;
}

export interface BotInlineButton {
  text: string;
  callbackData: string;
}

export interface BotMessageItem {
  id: string;
  sender: 'bot' | 'user';
  text: string;
  forwardedFrom?: {
    title: string;
    username?: string;
    chatId: string;
    isPublicOpen: boolean;
  };
  inlineKeyboard?: BotInlineButton[][];
  timestamp: string;
}

export interface StoreState {
  channels: SavedChannel[];
  connections: Connection[];
  logs: DeliveryLog[];
  rateLimitConfig: RateLimitConfig;
  recentHashes: string[];
}
