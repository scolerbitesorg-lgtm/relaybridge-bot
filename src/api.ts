import type {
  BootstrapResponse,
  BotChatMessage,
  ChannelAccessMode,
  ChannelRole,
  ChatKind,
  Connection,
  ConnectionFilterSettings,
  DeliveryLog,
  ExportBundle,
  MediaType,
  QueueSnapshot,
  RateLimitConfig,
  SavedChannel,
} from './types';

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  authStatus: () => request<{ passcodeProtected: boolean }>('/api/auth/status'),
  login: (passcode: string) =>
    request<{ token: string; passcodeProtected: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),
  bootstrap: () => request<BootstrapResponse>('/api/bootstrap'),

  createChannel: (payload: {
    telegramChatId: string;
    title: string;
    username?: string;
    kind: ChatKind;
    role: ChannelRole;
    accessMode: ChannelAccessMode;
    isBotAdmin?: boolean;
    userbotJoined?: boolean;
  }) =>
    request<{ channel: SavedChannel; channels: SavedChannel[] }>('/api/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateChannel: (
    id: string,
    patch: Partial<Pick<SavedChannel, 'title' | 'role' | 'kind' | 'accessMode' | 'isBotAdmin' | 'userbotJoined'>>,
  ) =>
    request<{ channel: SavedChannel; channels: SavedChannel[] }>(`/api/channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteChannel: (id: string) =>
    request<{ deleted: boolean; channels: SavedChannel[]; connections: Connection[] }>(
      `/api/channels/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  createConnection: (payload: {
    name?: string;
    sourceChannelId: string;
    targetChannelId: string;
    backupChannelId?: string | null;
    filters?: Partial<ConnectionFilterSettings>;
  }) =>
    request<{ connection: Connection; connections: Connection[] }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateConnection: (
    id: string,
    patch: Partial<{
      name: string;
      sourceChannelId: string;
      targetChannelId: string;
      backupChannelId: string | null;
      enabled: boolean;
      filters: Partial<ConnectionFilterSettings>;
    }>,
  ) =>
    request<{ connection: Connection; connections: Connection[] }>(
      `/api/connections/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    ),

  deleteConnection: (id: string) =>
    request<{ deleted: boolean; connections: Connection[] }>(`/api/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  updateRateLimit: (patch: Partial<RateLimitConfig>) =>
    request<{ rateLimit: RateLimitConfig; queue: QueueSnapshot }>('/api/rate-limit', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  simulateFloodWait: (channelId: string, seconds: number) =>
    request<{ queue: QueueSnapshot }>('/api/rate-limit/simulate-flood', {
      method: 'POST',
      body: JSON.stringify({ channelId, seconds }),
    }),

  clearLogs: () =>
    request<{ logs: DeliveryLog[] }>('/api/logs', {
      method: 'DELETE',
    }),

  dispatchTestPost: (payload: {
    sourceChannelId: string;
    mediaType: MediaType;
    caption?: string;
    fileName?: string;
    fileSizeMb?: number;
    burstCount?: number;
    sameFileUniqueId?: boolean;
  }) =>
    request<{
      matchedConnections: number;
      queuedTasks: number;
      filteredOut: number;
      queue: QueueSnapshot;
      connections: Connection[];
      logs: DeliveryLog[];
    }>('/api/dispatch/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  sendBotMessage: (text: string) =>
    request<{
      playgroundHistory: BotChatMessage[];
      channels: SavedChannel[];
      connections: Connection[];
    }>('/api/bot-playground/message', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  forwardPostToBot: (payload: {
    title: string;
    username?: string;
    telegramChatId?: string;
    kind: ChatKind;
    postPreview?: string;
  }) =>
    request<{
      playgroundHistory: BotChatMessage[];
      channels: SavedChannel[];
      connections: Connection[];
    }>('/api/bot-playground/forward', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  clickBotCallback: (callbackData: string) =>
    request<{
      playgroundHistory: BotChatMessage[];
      channels: SavedChannel[];
      connections: Connection[];
    }>('/api/bot-playground/callback', {
      method: 'POST',
      body: JSON.stringify({ callbackData }),
    }),

  resetBotHistory: () =>
    request<{ playgroundHistory: BotChatMessage[] }>('/api/bot-playground/history', {
      method: 'DELETE',
    }),

  restartEngine: () =>
    request<{ engine: import('./types').EngineStatus }>('/api/engine/restart', {
      method: 'POST',
    }),

  getExportBundle: () => request<ExportBundle>('/api/export'),
};
