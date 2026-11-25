import { store } from './store.ts';
import { rateLimitQueue } from './rateLimiter.ts';
import type {
  BotInlineButton,
  ChannelAccessMode,
  ChatKind,
  Connection,
  MediaType,
  SavedChannel,
} from './types.ts';

export interface BotReply {
  text: string;
  inlineKeyboard?: BotInlineButton[][];
}

interface WizardDraft {
  step: 'idle' | 'awaiting_source_input' | 'awaiting_target_input' | 'picking_target' | 'picking_backup';
  sourceChannelId?: string;
  targetChannelId?: string;
}

const userDrafts = new Map<string, WizardDraft>();

function getDraft(sessionKey: string): WizardDraft {
  let d = userDrafts.get(sessionKey);
  if (!d) {
    d = { step: 'idle' };
    userDrafts.set(sessionKey, d);
  }
  return d;
}

export const BOT_MENU_COMMANDS = [
  { command: 'start', description: 'Open main control menu' },
  { command: 'connections', description: 'Manage Source → Target connections' },
  { command: 'sources', description: 'Add or manage Source channels' },
  { command: 'targets', description: 'Add or manage Target & Backup channels' },
  { command: 'newconnection', description: 'Create a new forwarding connection' },
  { command: 'status', description: 'Live queue, rate limits & engine status' },
  { command: 'help', description: 'How to add open/private channels & filters' },
];

function formatChannelLabel(ch: SavedChannel): string {
  return ch.username ? `${ch.title} (@${ch.username})` : `${ch.title} (${ch.telegramChatId})`;
}

export function buildStartReply(): BotReply {
  const channels = store.getChannels();
  const connections = store.getConnections();
  const activeConns = connections.filter((c) => c.enabled).length;
  const sourcesCount = channels.filter((c) => c.role === 'source').length;
  const targetsCount = channels.filter((c) => c.role === 'target' || c.role === 'backup').length;

  return {
    text: [
      'RelayBridge Auto-Forwarding Hub',
      '',
      `Active Connections: ${activeConns} / ${connections.length}`,
      `Saved Sources: ${sourcesCount}  |  Targets & Backups: ${targetsCount}`,
      '',
      'Forward any post from any channel or group directly here, send @username / chat ID, or add me to a channel to assign it as Source or Target instantly.',
    ].join('\n'),
    inlineKeyboard: [
      [
        { text: 'Connections', callbackData: 'menu:connections' },
        { text: 'Sources', callbackData: 'menu:sources' },
      ],
      [
        { text: 'New Connection', callbackData: 'wizard:start' },
        { text: 'Targets & Backups', callbackData: 'menu:targets' },
      ],
      [
        { text: 'Queue & Status', callbackData: 'menu:status' },
        { text: 'Help Guide', callbackData: 'menu:help' },
      ],
    ],
  };
}

export function buildChannelDiscoveredReply(channel: SavedChannel, originNote: string): BotReply {
  return {
    text: [
      `Channel detected (${originNote}):`,
      `Name: ${channel.title}`,
      `ID: ${channel.telegramChatId}${channel.username ? `  |  @${channel.username}` : ''}`,
      `Access: ${channel.isBotAdmin ? 'Bot Admin' : 'Userbot Open Reader (no admin required)'}`,
      '',
      'Choose how you want to register this channel:',
    ].join('\n'),
    inlineKeyboard: [
      [
        { text: 'Set as Source', callbackData: `role:${channel.id}:source` },
        { text: 'Set as Target', callbackData: `role:${channel.id}:target` },
      ],
      [
        { text: 'Set as Backup Channel', callbackData: `role:${channel.id}:backup` },
      ],
      [{ text: 'Main Menu', callbackData: 'menu:start' }],
    ],
  };
}

export function buildSourcesReply(): BotReply {
  const sources = store.getChannels().filter((c) => c.role === 'source');
  const rows: BotInlineButton[][] = [];

  if (sources.length === 0) {
    rows.push([{ text: '+ Add Source Channel', callbackData: 'add:source' }]);
    rows.push([{ text: 'Main Menu', callbackData: 'menu:start' }]);
    return {
      text: [
        'Saved Source Channels (0)',
        '',
        'No source channels saved yet. Forward a post from any open/private channel here, or tap "+ Add Source Channel" to enter a @username, t.me link, or chat ID.',
        'Saved sources stay stored even before connecting to a target.',
      ].join('\n'),
      inlineKeyboard: rows,
    };
  }

  for (const src of sources.slice(0, 12)) {
    const connCount = store.getConnections().filter((c) => c.sourceChannelId === src.id).length;
    rows.push([
      {
        text: `${src.title} (${connCount} conn)`,
        callbackData: `source:view:${src.id}`,
      },
    ]);
  }
  rows.push([
    { text: '+ Add Source', callbackData: 'add:source' },
    { text: 'New Connection', callbackData: 'wizard:start' },
  ]);
  rows.push([{ text: 'Main Menu', callbackData: 'menu:start' }]);

  return {
    text: [
      `Saved Source Channels (${sources.length})`,
      '',
      'All saved sources are monitored live via Userbot (open channels without admin) or Bot API (admin channels). Tap any source to connect it to a target or manage it.',
    ].join('\n'),
    inlineKeyboard: rows,
  };
}

export function buildTargetsReply(): BotReply {
  const targets = store.getChannels().filter((c) => c.role === 'target' || c.role === 'backup');
  const rows: BotInlineButton[][] = [];

  for (const ch of targets.slice(0, 12)) {
    const tag = ch.role === 'backup' ? '[Backup]' : '[Target]';
    rows.push([
      {
        text: `${tag} ${ch.title}`,
        callbackData: `target:view:${ch.id}`,
      },
    ]);
  }
  rows.push([
    { text: '+ Add Target', callbackData: 'add:target' },
    { text: 'New Connection', callbackData: 'wizard:start' },
  ]);
  rows.push([{ text: 'Main Menu', callbackData: 'menu:start' }]);

  return {
    text:
      targets.length === 0
        ? 'Target & Backup Channels (0)\n\nNo target or backup channels saved yet. Forward a post from your destination channel or tap "+ Add Target".'
        : `Target & Backup Channels (${targets.length})\n\nSelect a channel to inspect or reassign its role.`,
    inlineKeyboard: rows,
  };
}

export function buildConnectionsReply(): BotReply {
  const connections = store.getConnections();
  const rows: BotInlineButton[][] = [];

  if (connections.length === 0) {
    rows.push([{ text: '+ Create First Connection', callbackData: 'wizard:start' }]);
    rows.push([
      { text: 'Sources', callbackData: 'menu:sources' },
      { text: 'Main Menu', callbackData: 'menu:start' },
    ]);
    return {
      text: 'Active Connections (0)\n\nNo Source → Target pipelines created yet. Tap "+ Create First Connection" to link a Source, Target, and optional Backup channel.',
      inlineKeyboard: rows,
    };
  }

  for (const conn of connections.slice(0, 12)) {
    const stateLabel = conn.enabled ? 'ON' : 'PAUSED';
    rows.push([
      {
        text: `[${stateLabel}] ${conn.name}`,
        callbackData: `conn:settings:${conn.id}`,
      },
    ]);
  }

  rows.push([
    { text: '+ New Connection', callbackData: 'wizard:start' },
    { text: 'Main Menu', callbackData: 'menu:start' },
  ]);

  return {
    text: [
      `Connections (${connections.length})`,
      '',
      'Tap any connection below to open its individual Settings panel (Videos, Files, Only With Caption, Strip Links, Copy/Forward Mode, Backup Channel, Pause/Resume).',
    ].join('\n'),
    inlineKeyboard: rows,
  };
}

export function buildConnectionSettingsReply(conn: Connection): BotReply {
  const src = store.getChannelById(conn.sourceChannelId);
  const tgt = store.getChannelById(conn.targetChannelId);
  const bkp = conn.backupChannelId ? store.getChannelById(conn.backupChannelId) : null;
  const f = conn.filters;

  const mark = (v: boolean) => (v ? 'ON' : 'OFF');
  const activeMedia = (Object.entries(f.allowedMedia) as Array<[MediaType, boolean]>)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(', ');

  return {
    text: [
      `Connection Settings: ${conn.name}`,
      `Status: ${conn.enabled ? 'ACTIVE (Live)' : 'PAUSED'}`,
      `Route: ${src?.title ?? 'Unknown'} -> ${tgt?.title ?? 'Unknown'}`,
      `Backup: ${bkp ? `${bkp.title} (${f.backupMode})` : 'None'}`,
      `Allowed Media: ${activeMedia || 'None'}`,
      `Only With Caption: ${mark(f.onlyWithCaption)}  |  Mode: ${f.forwardMode.toUpperCase()}`,
      `Strip Links: ${mark(f.stripLinks)}  |  Dedupe: ${mark(f.deduplicate)}  |  Userbot: ${mark(f.preferUserbot)}`,
      `Forwarded: ${conn.stats.forwardedCount}  |  Filtered: ${conn.stats.filteredOutCount}  |  Backup: ${conn.stats.backupCount}`,
    ].join('\n'),
    inlineKeyboard: [
      [
        { text: `Videos: ${mark(f.allowedMedia.video)}`, callbackData: `cset:${conn.id}:media_video` },
        { text: `Files: ${mark(f.allowedMedia.document)}`, callbackData: `cset:${conn.id}:media_document` },
        { text: `Photos: ${mark(f.allowedMedia.photo)}`, callbackData: `cset:${conn.id}:media_photo` },
      ],
      [
        { text: `Audio: ${mark(f.allowedMedia.audio)}`, callbackData: `cset:${conn.id}:media_audio` },
        { text: `Text: ${mark(f.allowedMedia.text)}`, callbackData: `cset:${conn.id}:media_text` },
        { text: `GIFs: ${mark(f.allowedMedia.animation)}`, callbackData: `cset:${conn.id}:media_animation` },
      ],
      [
        { text: `Only Caption: ${mark(f.onlyWithCaption)}`, callbackData: `cset:${conn.id}:onlyWithCaption` },
        { text: `Mode: ${f.forwardMode === 'copy' ? 'Copy' : 'Forward'}`, callbackData: `cset:${conn.id}:forwardMode` },
      ],
      [
        { text: `Strip Links: ${mark(f.stripLinks)}`, callbackData: `cset:${conn.id}:stripLinks` },
        { text: `Backup: ${f.backupMode.toUpperCase()}`, callbackData: `cset:${conn.id}:backupMode` },
      ],
      [
        { text: 'Preset: Video + Caption Only', callbackData: `cset:${conn.id}:preset_vidcap` },
        { text: 'Preset: Files & Videos', callbackData: `cset:${conn.id}:preset_filesvid` },
      ],
      [
        {
          text: conn.enabled ? 'Pause Connection' : 'Resume Connection',
          callbackData: `cset:${conn.id}:toggle_enabled`,
        },
        { text: 'Delete', callbackData: `conn:delete:${conn.id}` },
      ],
      [{ text: 'Back to Connections', callbackData: 'menu:connections' }],
    ],
  };
}

export function buildWizardPickSourceReply(): BotReply {
  const sources = store.getChannels().filter((c) => c.role === 'source');
  const candidates = sources.length > 0 ? sources : store.getChannels();

  if (candidates.length === 0) {
    return {
      text: 'Step 1 of 3 — Select Source\n\nYou have no saved channels yet. Forward any post from a channel here or add a source channel first.',
      inlineKeyboard: [
        [{ text: '+ Add Source Channel', callbackData: 'add:source' }],
        [{ text: 'Main Menu', callbackData: 'menu:start' }],
      ],
    };
  }

  const rows: BotInlineButton[][] = candidates.slice(0, 10).map((ch) => [
    { text: `Source: ${formatChannelLabel(ch)}`, callbackData: `wizard:src:${ch.id}` },
  ]);
  rows.push([{ text: 'Cancel', callbackData: 'menu:start' }]);

  return {
    text: 'Step 1 of 3 — Select Source Channel\n\nChoose which channel or group the bot/userbot will read incoming posts from:',
    inlineKeyboard: rows,
  };
}

function buildWizardPickTargetReply(sourceChannelId: string): BotReply {
  const source = store.getChannelById(sourceChannelId);
  const targets = store
    .getChannels()
    .filter((c) => c.id !== sourceChannelId && (c.role === 'target' || c.role === 'unassigned'));
  const fallback = store.getChannels().filter((c) => c.id !== sourceChannelId);
  const candidates = targets.length > 0 ? targets : fallback;

  if (candidates.length === 0) {
    return {
      text: `Step 2 of 3 — Select Target\n\nSource: ${source?.title ?? sourceChannelId}\n\nNo target channels available yet. Forward a post from your target channel or add one now:`,
      inlineKeyboard: [
        [{ text: '+ Add Target Channel', callbackData: 'add:target' }],
        [{ text: 'Main Menu', callbackData: 'menu:start' }],
      ],
    };
  }

  const rows: BotInlineButton[][] = candidates.slice(0, 10).map((ch) => [
    { text: `Target: ${formatChannelLabel(ch)}`, callbackData: `wizard:tgt:${sourceChannelId}:${ch.id}` },
  ]);
  rows.push([{ text: 'Back', callbackData: 'wizard:start' }]);

  return {
    text: `Step 2 of 3 — Select Target Channel\n\nSource: ${source?.title ?? sourceChannelId}\n\nSelect where matching videos, files, and posts should be forwarded:`,
    inlineKeyboard: rows,
  };
}

function buildWizardPickBackupReply(sourceChannelId: string, targetChannelId: string): BotReply {
  const source = store.getChannelById(sourceChannelId);
  const target = store.getChannelById(targetChannelId);
  const backups = store
    .getChannels()
    .filter((c) => c.id !== sourceChannelId && c.id !== targetChannelId);

  const rows: BotInlineButton[][] = [
    [
      {
        text: 'Skip Backup & Create Connection',
        callbackData: `wizard:finish:${sourceChannelId}:${targetChannelId}:none`,
      },
    ],
  ];

  for (const ch of backups.slice(0, 8)) {
    rows.push([
      {
        text: `Backup: ${formatChannelLabel(ch)}`,
        callbackData: `wizard:finish:${sourceChannelId}:${targetChannelId}:${ch.id}`,
      },
    ]);
  }
  rows.push([{ text: 'Cancel', callbackData: 'menu:start' }]);

  return {
    text: [
      'Step 3 of 3 — Optional Backup Channel',
      '',
      `Source: ${source?.title ?? sourceChannelId}`,
      `Target: ${target?.title ?? targetChannelId}`,
      '',
      'Pick a backup channel (auto-failover or mirror) or skip to activate immediately:',
    ].join('\n'),
    inlineKeyboard: rows,
  };
}

export function buildStatusReply(): BotReply {
  const snap = rateLimitQueue.getSnapshot();
  const cfg = store.getRateLimitConfig();
  const activeConns = store.getConnections().filter((c) => c.enabled).length;

  return {
    text: [
      'Live Engine & Rate-Limit Status',
      '',
      `Active Connections: ${activeConns} / ${store.getConnections().length}`,
      `Saved Channels: ${store.getChannels().length}`,
      `Queue Pending: ${snap.pendingCount}  |  In-Flight: ${snap.processingCount}`,
      `Global Rate Budget: ${snap.globalTokensAvailable}/${cfg.globalMaxPerSecond} msg/sec`,
      `Per-Chat Limit: ${cfg.perChatMaxPerSecond}/sec, ${cfg.perChatMaxPerMinute}/min`,
      `Active FloodWaits: ${snap.activeFloodWaits.length}`,
      `Total Delivered: ${snap.totalProcessed}  |  Rate-Limited Retries: ${snap.totalRateLimited}`,
    ].join('\n'),
    inlineKeyboard: [
      [
        { text: 'Connections', callbackData: 'menu:connections' },
        { text: 'Sources', callbackData: 'menu:sources' },
      ],
      [{ text: 'Refresh Status', callbackData: 'menu:status' }],
    ],
  };
}

export function buildHelpReply(): BotReply {
  return {
    text: [
      'How to Use RelayBridge Bot',
      '',
      '1. Add Any Source (Even Without Admin Rights):',
      '   - Forward ANY post from an open/public channel directly to this bot, OR',
      '   - Send @channel_username / https://t.me/channel / -100... ID, OR',
      '   - Add this bot to your channel or group.',
      '   - Tap "Set as Source" or "Set as Target" on the instant prompt.',
      '',
      '2. Create Unlimited Connections:',
      '   - Use /newconnection -> Pick Source -> Pick Target -> Optional Backup Channel.',
      '',
      '3. Separate Per-Connection Settings:',
      '   - Open /connections -> tap any connection to toggle Only Videos with Caption, Files, Photos, Copy vs Forward mode, Strip Links, and Backup Mirror/Failover.',
      '',
      '4. Zero-Stop Rate Limiting & Userbot:',
      '   - Heavy videos & files route through MTProto Userbot with automatic per-chat throttling and FLOOD_WAIT recovery.',
    ].join('\n'),
    inlineKeyboard: [
      [
        { text: 'Connections', callbackData: 'menu:connections' },
        { text: 'Sources', callbackData: 'menu:sources' },
      ],
      [{ text: 'Main Menu', callbackData: 'menu:start' }],
    ],
  };
}

export function handleForwardedChannelDiscovery(input: {
  telegramChatId: string;
  title: string;
  username?: string;
  kind: ChatKind;
  accessMode: ChannelAccessMode;
  isBotAdmin?: boolean;
  originNote: string;
}): { channel: SavedChannel; reply: BotReply } {
  const channel = store.upsertChannel({
    telegramChatId: input.telegramChatId,
    title: input.title,
    username: input.username,
    kind: input.kind,
    role: 'unassigned',
    accessMode: input.accessMode,
    isBotAdmin: input.isBotAdmin ?? false,
    userbotJoined: input.accessMode === 'userbot_open' || input.accessMode === 'forwarded_post',
  });
  return {
    channel,
    reply: buildChannelDiscoveredReply(channel, input.originNote),
  };
}

function parseChannelInput(raw: string): { telegramChatId: string; title: string; username?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Match https://t.me/username or t.me/username
  const linkMatch = trimmed.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{4,})/i);
  if (linkMatch) {
    const username = linkMatch[1];
    return {
      telegramChatId: `@${username}`,
      title: `@${username}`,
      username,
    };
  }

  // Match @username
  const handleMatch = trimmed.match(/^@([a-zA-Z0-9_]{4,})$/);
  if (handleMatch) {
    const username = handleMatch[1];
    return {
      telegramChatId: `@${username}`,
      title: `@${username}`,
      username,
    };
  }

  // Match numeric Telegram channel/group ID (-100xxxxxxxxxx or -xxxxxxxx)
  const idMatch = trimmed.match(/^-?\d{6,16}$/);
  if (idMatch) {
    return {
      telegramChatId: trimmed,
      title: `Channel ${trimmed}`,
    };
  }

  return null;
}

export function handleTextCommand(sessionKey: string, rawText: string): BotReply {
  const text = rawText.trim();
  const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? '';
  const draft = getDraft(sessionKey);

  if (cmd === '/start' || cmd === '/menu') {
    draft.step = 'idle';
    return buildStartReply();
  }
  if (cmd === '/connections') {
    draft.step = 'idle';
    return buildConnectionsReply();
  }
  if (cmd === '/sources') {
    draft.step = 'idle';
    return buildSourcesReply();
  }
  if (cmd === '/targets') {
    draft.step = 'idle';
    return buildTargetsReply();
  }
  if (cmd === '/newconnection') {
    draft.step = 'idle';
    return buildWizardPickSourceReply();
  }
  if (cmd === '/status') {
    return buildStatusReply();
  }
  if (cmd === '/help') {
    return buildHelpReply();
  }

  // Check if user sent a @username, t.me link, or numeric chat ID
  const parsed = parseChannelInput(text);
  if (parsed) {
    if (draft.step === 'awaiting_source_input') {
      draft.step = 'idle';
      const channel = store.upsertChannel({
        telegramChatId: parsed.telegramChatId,
        title: parsed.title,
        username: parsed.username,
        kind: 'channel',
        role: 'source',
        accessMode: 'userbot_open',
        isBotAdmin: false,
        userbotJoined: true,
      });
      return {
        text: [
          `Source saved: ${formatChannelLabel(channel)}`,
          'Userbot open-channel reader armed (works without admin rights on public channels/groups).',
          '',
          'Connect this source to a target now, or keep it saved in Sources for later:',
        ].join('\n'),
        inlineKeyboard: [
          [{ text: 'Select Target & Connect Now', callbackData: `wizard:src:${channel.id}` }],
          [
            { text: 'View All Sources', callbackData: 'menu:sources' },
            { text: 'Main Menu', callbackData: 'menu:start' },
          ],
        ],
      };
    }

    if (draft.step === 'awaiting_target_input') {
      draft.step = 'idle';
      const channel = store.upsertChannel({
        telegramChatId: parsed.telegramChatId,
        title: parsed.title,
        username: parsed.username,
        kind: 'channel',
        role: 'target',
        accessMode: 'bot_admin',
        isBotAdmin: true,
        userbotJoined: true,
      });
      return {
        text: `Target saved: ${formatChannelLabel(channel)}\n\nYou can now link any Source channel to this Target.`,
        inlineKeyboard: [
          [{ text: 'Create Connection', callbackData: 'wizard:start' }],
          [
            { text: 'View Targets', callbackData: 'menu:targets' },
            { text: 'Main Menu', callbackData: 'menu:start' },
          ],
        ],
      };
    }

    const { reply } = handleForwardedChannelDiscovery({
      telegramChatId: parsed.telegramChatId,
      title: parsed.title,
      username: parsed.username,
      kind: 'channel',
      accessMode: 'manual_link',
      isBotAdmin: false,
      originNote: 'username / link',
    });
    return reply;
  }

  return {
    text: [
      `Command received: "${text.slice(0, 60)}"`,
      '',
      'Tip: Forward any post from a channel, send @channel_username / t.me link / -100... chat ID, or pick an action from the Menu below:',
    ].join('\n'),
    inlineKeyboard: buildStartReply().inlineKeyboard,
  };
}

export function handleCallbackAction(sessionKey: string, data: string): BotReply {
  const draft = getDraft(sessionKey);

  if (data === 'menu:start') {
    draft.step = 'idle';
    return buildStartReply();
  }
  if (data === 'menu:connections') {
    draft.step = 'idle';
    return buildConnectionsReply();
  }
  if (data === 'menu:sources') {
    draft.step = 'idle';
    return buildSourcesReply();
  }
  if (data === 'menu:targets') {
    draft.step = 'idle';
    return buildTargetsReply();
  }
  if (data === 'menu:status') {
    return buildStatusReply();
  }
  if (data === 'menu:help') {
    return buildHelpReply();
  }

  if (data === 'add:source') {
    draft.step = 'awaiting_source_input';
    return {
      text: [
        'Add a Source Channel or Group',
        '',
        'Send any of the following:',
        '1. Forward ANY post from that channel/group into this chat',
        '2. Send @channel_username or https://t.me/channel_name',
        '3. Send numeric chat ID (e.g. -1001928374650)',
        '',
        'Open/public sources work without making the bot an admin (read via Userbot).',
      ].join('\n'),
      inlineKeyboard: [[{ text: 'Cancel', callbackData: 'menu:sources' }]],
    };
  }

  if (data === 'add:target') {
    draft.step = 'awaiting_target_input';
    return {
      text: [
        'Add a Target or Backup Channel / Group',
        '',
        'Forward a post from your target channel, add this bot as admin there, or send its @username / -100... chat ID:',
      ].join('\n'),
      inlineKeyboard: [[{ text: 'Cancel', callbackData: 'menu:targets' }]],
    };
  }

  // Assign role from discovered channel prompt: role:<channelId>:<source|target|backup>
  if (data.startsWith('role:')) {
    const [, channelId, role] = data.split(':');
    if (role === 'source' || role === 'target' || role === 'backup') {
      const updated = store.updateChannel(channelId, {
        role,
        userbotJoined: role === 'source' ? true : undefined,
      });
      if (!updated) {
        return { text: 'Channel not found.', inlineKeyboard: buildStartReply().inlineKeyboard };
      }
      if (role === 'source') {
        return {
          text: [
            `Saved as SOURCE: ${formatChannelLabel(updated)}`,
            '',
            'Now select a Target channel to create a live Source -> Target connection, or keep this Source saved for later:',
          ].join('\n'),
          inlineKeyboard: [
            [{ text: 'Select Target & Connect Now', callbackData: `wizard:src:${updated.id}` }],
            [
              { text: 'Keep Saved in Sources', callbackData: 'menu:sources' },
              { text: 'Main Menu', callbackData: 'menu:start' },
            ],
          ],
        };
      }
      return {
        text: `Saved as ${role.toUpperCase()}: ${formatChannelLabel(updated)}\n\nReady to receive forwarded posts, videos, and files.`,
        inlineKeyboard: [
          [{ text: 'Create Connection Now', callbackData: 'wizard:start' }],
          [
            { text: 'View Targets', callbackData: 'menu:targets' },
            { text: 'Main Menu', callbackData: 'menu:start' },
          ],
        ],
      };
    }
  }

  // View individual source or target
  if (data.startsWith('source:view:') || data.startsWith('target:view:')) {
    const chId = data.split(':')[2];
    const ch = store.getChannelById(chId);
    if (!ch) return buildSourcesReply();
    const linked = store
      .getConnections()
      .filter((c) => c.sourceChannelId === ch.id || c.targetChannelId === ch.id || c.backupChannelId === ch.id);

    return {
      text: [
        `Channel Details: ${ch.title}`,
        `Role: ${ch.role.toUpperCase()}  |  Chat ID: ${ch.telegramChatId}`,
        `Access Mode: ${ch.isBotAdmin ? 'Bot Admin' : 'Userbot Open Reader'}`,
        `Linked Connections: ${linked.length}`,
      ].join('\n'),
      inlineKeyboard: [
        ch.role === 'source'
          ? [{ text: 'Connect to a Target Channel', callbackData: `wizard:src:${ch.id}` }]
          : [{ text: 'New Connection', callbackData: 'wizard:start' }],
        [
          { text: 'Switch to Source', callbackData: `role:${ch.id}:source` },
          { text: 'Switch to Target', callbackData: `role:${ch.id}:target` },
        ],
        [
          { text: 'Delete Channel', callbackData: `channel:delete:${ch.id}` },
          { text: 'Back', callbackData: ch.role === 'source' ? 'menu:sources' : 'menu:targets' },
        ],
      ],
    };
  }

  if (data.startsWith('channel:delete:')) {
    const chId = data.split(':')[2];
    store.deleteChannel(chId);
    return {
      text: 'Channel removed from saved list.',
      inlineKeyboard: buildStartReply().inlineKeyboard,
    };
  }

  // Connection Creation Wizard
  if (data === 'wizard:start') {
    return buildWizardPickSourceReply();
  }
  if (data.startsWith('wizard:src:')) {
    const sourceId = data.split(':')[2];
    draft.step = 'picking_target';
    draft.sourceChannelId = sourceId;
    return buildWizardPickTargetReply(sourceId);
  }
  if (data.startsWith('wizard:tgt:')) {
    const [, , sourceId, targetId] = data.split(':');
    draft.step = 'picking_backup';
    draft.sourceChannelId = sourceId;
    draft.targetChannelId = targetId;
    return buildWizardPickBackupReply(sourceId, targetId);
  }
  if (data.startsWith('wizard:finish:')) {
    const [, , sourceId, targetId, backupArg] = data.split(':');
    draft.step = 'idle';
    const created = store.createConnection({
      sourceChannelId: sourceId,
      targetChannelId: targetId,
      backupChannelId: backupArg === 'none' ? null : backupArg,
    });
    if (!created) {
      return {
        text: 'Could not create connection. Make sure Source and Target are different valid channels.',
        inlineKeyboard: buildStartReply().inlineKeyboard,
      };
    }
    return buildConnectionSettingsReply(created);
  }

  // Per-Connection Settings & Toggles
  if (data.startsWith('conn:settings:')) {
    const connId = data.split(':')[2];
    const conn = store.getConnectionById(connId);
    if (!conn) return buildConnectionsReply();
    return buildConnectionSettingsReply(conn);
  }

  if (data.startsWith('conn:delete:')) {
    const connId = data.split(':')[2];
    store.deleteConnection(connId);
    return buildConnectionsReply();
  }

  if (data.startsWith('cset:')) {
    const [, connId, action] = data.split(':');
    const conn = store.getConnectionById(connId);
    if (!conn) return buildConnectionsReply();
    const f = conn.filters;

    if (action.startsWith('media_')) {
      const mediaKey = action.replace('media_', '') as MediaType;
      if (mediaKey in f.allowedMedia) {
        store.updateConnection(conn.id, {
          filters: {
            allowedMedia: {
              ...f.allowedMedia,
              [mediaKey]: !f.allowedMedia[mediaKey],
            },
          },
        });
      }
    } else if (action === 'onlyWithCaption') {
      store.updateConnection(conn.id, { filters: { onlyWithCaption: !f.onlyWithCaption } });
    } else if (action === 'forwardMode') {
      store.updateConnection(conn.id, {
        filters: { forwardMode: f.forwardMode === 'copy' ? 'forward' : 'copy' },
      });
    } else if (action === 'stripLinks') {
      store.updateConnection(conn.id, { filters: { stripLinks: !f.stripLinks } });
    } else if (action === 'backupMode') {
      const order: Array<'off' | 'failover' | 'mirror'> = ['failover', 'mirror', 'off'];
      const nextMode = order[(order.indexOf(f.backupMode) + 1) % order.length];
      store.updateConnection(conn.id, { filters: { backupMode: nextMode } });
    } else if (action === 'preset_vidcap') {
      store.updateConnection(conn.id, {
        filters: {
          allowedMedia: {
            video: true,
            document: false,
            photo: false,
            audio: false,
            voice: false,
            animation: false,
            sticker: false,
            text: false,
            poll: false,
          },
          onlyWithCaption: true,
        },
      });
    } else if (action === 'preset_filesvid') {
      store.updateConnection(conn.id, {
        filters: {
          allowedMedia: {
            video: true,
            document: true,
            photo: false,
            audio: false,
            voice: false,
            animation: false,
            sticker: false,
            text: false,
            poll: false,
          },
          onlyWithCaption: false,
        },
      });
    } else if (action === 'toggle_enabled') {
      store.updateConnection(conn.id, { enabled: !conn.enabled });
    }

    const refreshed = store.getConnectionById(conn.id);
    return refreshed ? buildConnectionSettingsReply(refreshed) : buildConnectionsReply();
  }

  return buildStartReply();
}
