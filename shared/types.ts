export type ChannelRole = 'source' | 'target' | 'backup' | 'unassigned';
export type ChannelAccessMode = 'bot_admin' | 'bot_member' | 'userbot_open' | 'forwarded_post';
export type ChannelType = 'channel' | 'supergroup' | 'group';

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

export interface SavedChannel {
  id: string; // Internal UUID
  chatId: string; // Telegram numeric chat ID (e.g. "-1001984231102") or resolved handle
  title: string;
  username?: string; // e.g. "@movies_hub"
  type: ChannelType;
  role: ChannelRole;
  accessMode: ChannelAccessMode;
  isPublic: boolean;
  requiresUserbot: boolean;
  addedVia: 'bot_added' | 'forwarded_post' | 'manual_username' | 'dashboard';
  createdAt: string;
  lastActivityAt?: string;
}

export interface ReplaceRule {
  find: string;
  replace: string;
}

export interface ConnectionFilterSettings {
  allowedMedia: Record<MediaType, boolean>;
  onlyWithCaption: boolean; // e.g., forward videos/files ONLY if they have a caption
  forwardMode: 'copy' | 'forward'; // copy removes "Forwarded from" header
  captionMode: 'keep' | 'strip' | 'custom';
  captionPrefix: string;
  captionSuffix: string;
  stripLinks: boolean;
  stripUsernames: boolean;
  stripHashtags: boolean;
  includeKeywords: string[]; // If non-empty, message text/caption must match at least one
  excludeKeywords: string[]; // Skip if text/caption contains any of these
  replaceRules: ReplaceRule[];
  minFileSizeMb: number; // 0 = no min
  maxFileSizeMb: number; // 0 = unlimited (Userbot supports up to 2000-4000MB)
  skipDuplicates: boolean;
  delaySeconds: number; // Optional per-connection throttle delay
  preferUserbotForLargeFiles: boolean; // Automatically route >20MB or open sources through Userbot
  backupMode: 'off' | 'mirror' | 'failover'; // mirror = send to both target & backup; failover = send to backup if target fails
}

export interface Connection {
  id: string;
  name: string;
  sourceChannelId: string; // references SavedChannel.id
  targetChannelId: string; // references SavedChannel.id
  backupChannelId: string | null; // optional backup channel
  enabled: boolean;
  filters: ConnectionFilterSettings;
  stats: {
    forwarded: number;
    filteredOut: number;
    failed: number;
    backupUsed: number;
    lastForwardedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface IncomingMessagePayload {
  sourceChannelId: string;
  sourceChatId: string;
  messageId: number;
  mediaType: MediaType;
  caption?: string;
  text?: string;
  fileName?: string;
  fileSizeMb?: number;
  fileUniqueId?: string;
  receivedVia: 'bot_api' | 'userbot_mtproto' | 'playground';
  timestamp: string;
}

export type DeliveryStatus =
  | 'queued'
  | 'rate_limited'
  | 'retrying'
  | 'delivered'
  | 'delivered_backup'
  | 'filtered'
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
  captionPreview?: string;
  transport: 'bot_api' | 'userbot_mtproto' | 'simulated';
  status: DeliveryStatus;
  reason?: string;
  waitMs?: number;
  attempts: number;
  createdAt: string;
  completedAt?: string;
}

export interface RateLimitConfig {
  globalMaxPerSecond: number; // Safe Telegram cap: 25/sec
  perChatMaxPerSecond: number; // Safe Telegram cap: 1/sec
  perChatMaxPerMinute: number; // Safe group cap: 18/min
  autoFloodWaitRecovery: boolean;
  maxRetries: number;
  burstBufferSize: number;
}

export interface RateLimitMetrics {
  queueDepth: number;
  processing: boolean;
  globalTokensRemaining: number;
  globalSentLastSecond: number;
  activeCooldownChats: Array<{
    chatId: string;
    title: string;
    resumeAt: string;
    reason: string;
  }>;
  totalProcessed: number;
  totalFloodWaitsHandled: number;
  totalRetried: number;
}

export interface BotInlineButton {
  text: string;
  callbackData: string;
}

export interface BotChatMessage {
  id: string;
  sender: 'user' | 'bot' | 'system';
  text: string;
  timestamp: string;
  forwardedFrom?: {
    chatId: string;
    title: string;
    username?: string;
    type: ChannelType;
    isPublic: boolean;
  };
  buttons?: BotInlineButton[][];
}

export interface EngineStatus {
  botApiConfigured: boolean;
  botApiRunning: boolean;
  botUsername: string | null;
  botError: string | null;
  userbotConfigured: boolean;
  userbotRunning: boolean;
  userbotAccount: string | null;
  userbotError: string | null;
  adminGuardEnabled: boolean;
  passcodeEnabled: boolean;
  uptimeSeconds: number;
  activeConnectionsCount: number;
  savedChannelsCount: number;
  rateLimit: RateLimitMetrics;
}

export function createDefaultFilterSettings(
  overrides?: Partial<ConnectionFilterSettings>
): ConnectionFilterSettings {
  return {
    allowedMedia: {
      video: true,
      document: true,
      photo: true,
      audio: true,
      voice: false,
      animation: true,
      sticker: false,
      text: false,
      poll: false,
      ...(overrides?.allowedMedia ?? {}),
    },
    onlyWithCaption: overrides?.onlyWithCaption ?? false,
    forwardMode: overrides?.forwardMode ?? 'copy',
    captionMode: overrides?.captionMode ?? 'keep',
    captionPrefix: overrides?.captionPrefix ?? '',
    captionSuffix: overrides?.captionSuffix ?? '',
    stripLinks: overrides?.stripLinks ?? false,
    stripUsernames: overrides?.stripUsernames ?? false,
    stripHashtags: overrides?.stripHashtags ?? false,
    includeKeywords: overrides?.includeKeywords ?? [],
    excludeKeywords: overrides?.excludeKeywords ?? [],
    replaceRules: overrides?.replaceRules ?? [],
    minFileSizeMb: overrides?.minFileSizeMb ?? 0,
    maxFileSizeMb: overrides?.maxFileSizeMb ?? 0,
    skipDuplicates: overrides?.skipDuplicates ?? true,
    delaySeconds: overrides?.delaySeconds ?? 0,
    preferUserbotForLargeFiles: overrides?.preferUserbotForLargeFiles ?? true,
    backupMode: overrides?.backupMode ?? 'failover',
  };
}
