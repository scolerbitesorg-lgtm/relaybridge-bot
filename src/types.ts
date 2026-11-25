export type ChannelRole = 'source' | 'target' | 'backup' | 'unassigned';

export type ChannelAccessMode = 'bot_admin' | 'userbot_open' | 'forwarded_post' | 'manual_link';

export type ChatKind = 'channel' | 'supergroup' | 'group';

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
  id: string;
  telegramChatId: string;
  title: string;
  username?: string;
  kind: ChatKind;
  role: ChannelRole;
  accessMode: ChannelAccessMode;
  isBotAdmin: boolean;
  userbotJoined: boolean;
  memberCount?: number;
  createdAt: string;
  lastActivityAt?: string;
}

export interface FindReplaceRule {
  id: string;
  find: string;
  replace: string;
}

export interface ConnectionFilterSettings {
  allowedMedia: Record<MediaType, boolean>;
  onlyWithCaption: boolean;
  stripCaption: boolean;
  forwardMode: 'copy' | 'forward';
  stripLinks: boolean;
  stripUsernames: boolean;
  deduplicate: boolean;
  captionPrefix: string;
  captionSuffix: string;
  keywordWhitelist: string[];
  keywordBlacklist: string[];
  findReplace: FindReplaceRule[];
  minFileSizeMb: number;
  maxFileSizeMb: number;
  delaySeconds: number;
  backupMode: 'off' | 'mirror' | 'failover';
  preferUserbot: boolean;
}

export interface Connection {
  id: string;
  name: string;
  sourceChannelId: string;
  targetChannelId: string;
  backupChannelId: string | null;
  enabled: boolean;
  filters: ConnectionFilterSettings;
  stats: {
    forwardedCount: number;
    filteredOutCount: number;
    backupCount: number;
    errorCount: number;
    lastForwardedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RateLimitConfig {
  globalMaxPerSecond: number;
  perChatMaxPerSecond: number;
  perChatMaxPerMinute: number;
  maxRetries: number;
  autoFloodBackoff: boolean;
}

export interface DeliveryLog {
  id: string;
  timestamp: string;
  connectionId: string;
  connectionName: string;
  sourceTitle: string;
  targetTitle: string;
  backupTitle?: string;
  mediaType: MediaType;
  fileName?: string;
  fileSizeMb?: number;
  captionPreview: string;
  transport: 'userbot' | 'bot_api' | 'simulation';
  status: 'delivered' | 'filtered' | 'queued' | 'rate_limited' | 'backup_delivered' | 'failed';
  detail: string;
  latencyMs: number;
}

export interface QueueSnapshot {
  pendingCount: number;
  processingCount: number;
  globalTokensAvailable: number;
  globalMaxPerSecond: number;
  activeFloodWaits: Array<{
    chatId: string;
    chatTitle: string;
    unlockAt: string;
    remainingSeconds: number;
  }>;
  totalProcessed: number;
  totalRateLimited: number;
  totalErrors: number;
}

export interface EngineStatus {
  botApiConfigured: boolean;
  botApiRunning: boolean;
  botUsername?: string;
  userbotConfigured: boolean;
  userbotRunning: boolean;
  userbotAccount?: string;
  adminRestrictionEnabled: boolean;
  passcodeProtected: boolean;
  uptimeSeconds: number;
  lastError?: string;
}

export interface BotInlineButton {
  text: string;
  callbackData: string;
}

export interface BotChatMessage {
  id: string;
  sender: 'user' | 'bot';
  timestamp: string;
  text: string;
  forwardedFrom?: {
    chatId: string;
    title: string;
    username?: string;
    kind: ChatKind;
  };
  inlineKeyboard?: BotInlineButton[][];
}

export interface BotCommandInfo {
  command: string;
  description: string;
}

export interface BootstrapResponse {
  channels: SavedChannel[];
  connections: Connection[];
  logs: DeliveryLog[];
  rateLimit: RateLimitConfig;
  queue: QueueSnapshot;
  engine: EngineStatus;
  playgroundHistory: BotChatMessage[];
  commands: BotCommandInfo[];
}

export interface ExportBundle {
  pythonBot: string;
  requirementsTxt: string;
  envTemplate: string;
  configJson: string;
  readmeMd: string;
}
