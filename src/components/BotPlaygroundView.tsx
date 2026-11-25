import React, { useEffect, useRef, useState } from 'react';
import { Forward, Menu, RotateCcw, Send, Zap } from 'lucide-react';
import type {
  BotChatMessage,
  BotCommandInfo,
  ChatKind,
  MediaType,
  SavedChannel,
} from '../types';

interface BotPlaygroundViewProps {
  history: BotChatMessage[];
  commands: BotCommandInfo[];
  channels: SavedChannel[];
  botUsername?: string;
  onSendMessage: (text: string) => Promise<void>;
  onForwardPost: (payload: {
    title: string;
    username?: string;
    telegramChatId?: string;
    kind: ChatKind;
    postPreview?: string;
  }) => Promise<void>;
  onClickCallback: (callbackData: string) => Promise<void>;
  onResetHistory: () => Promise<void>;
  onDispatchTestPost: (payload: {
    sourceChannelId: string;
    mediaType: MediaType;
    caption?: string;
    fileSizeMb?: number;
    burstCount?: number;
  }) => Promise<{ matchedConnections: number; queuedTasks: number; filteredOut: number }>;
}

const SAMPLE_FORWARD_CHANNELS = [
  {
    title: 'Open 4K Video Hub',
    username: 'open_4k_videos',
    kind: 'channel' as ChatKind,
    postPreview: 'Forwarded Video · Documentary_4K.mp4 (312 MB) — "Full 4K episode with subtitles"',
  },
  {
    title: 'My Target Archive',
    username: 'my_target_archive',
    kind: 'channel' as ChatKind,
    postPreview: 'Forwarded Post · Welcome to My Target Archive',
  },
  {
    title: 'Backup Mirror Vault',
    username: 'backup_mirror_vault',
    kind: 'channel' as ChatKind,
    postPreview: 'Forwarded Post · Backup Channel initialized',
  },
];

export const BotPlaygroundView: React.FC<BotPlaygroundViewProps> = ({
  history,
  commands,
  channels,
  botUsername,
  onSendMessage,
  onForwardPost,
  onClickCallback,
  onResetHistory,
  onDispatchTestPost,
}) => {
  const [input, setInput] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Forward-post simulator state
  const [fwdTitle, setFwdTitle] = useState('');
  const [fwdUsername, setFwdUsername] = useState('');
  const [fwdKind, setFwdKind] = useState<ChatKind>('channel');

  // Incoming source post simulator state
  const sources = channels.filter((c) => c.role === 'source');
  const [simSourceId, setSimSourceId] = useState('');
  const [simMedia, setSimMedia] = useState<MediaType>('video');
  const [simCaption, setSimCaption] = useState('Episode 12 1080p Hindi Dual Audio @promo_link https://t.me/spam');
  const [simSizeMb, setSimSizeMb] = useState<number>(85);
  const [simBurst, setSimBurst] = useState<number>(1);
  const [simFeedback, setSimFeedback] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history.length]);

  useEffect(() => {
    if (!simSourceId && sources.length > 0) {
      setSimSourceId(sources[0].id);
    }
  }, [sources, simSourceId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const text = input.trim();
    setInput('');
    setMenuOpen(false);
    setBusy(true);
    try {
      await onSendMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const handleCommandClick = async (cmd: string) => {
    setMenuOpen(false);
    setBusy(true);
    try {
      await onSendMessage(`/${cmd}`);
    } finally {
      setBusy(false);
    }
  };

  const handleForwardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fwdTitle.trim() || busy) return;
    setBusy(true);
    try {
      await onForwardPost({
        title: fwdTitle.trim(),
        username: fwdUsername.trim().replace(/^@/, '') || undefined,
        kind: fwdKind,
      });
      setFwdTitle('');
      setFwdUsername('');
    } finally {
      setBusy(false);
    }
  };

  const handleSimDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetSrc = simSourceId || sources[0]?.id;
    if (!targetSrc) return;
    setSimFeedback('');
    const result = await onDispatchTestPost({
      sourceChannelId: targetSrc,
      mediaType: simMedia,
      caption: simCaption,
      fileSizeMb: simSizeMb,
      burstCount: simBurst,
    });
    setSimFeedback(
      `Matched ${result.matchedConnections} active connection(s) · Queued ${result.queuedTasks} · Filtered out ${result.filteredOut}`,
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Interactive Bot Playground
        </h1>
        <p className="mt-1 text-sm text-slate-600 max-w-2xl">
          Test the exact Telegram Bot Menu, inline buttons, forwarded-post channel discovery (Set as Source / Set as Target), per-connection settings, and live forwarding queue directly here.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        {/* Left: Live Telegram Bot Chat Window */}
        <div className="lg:col-span-7 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden h-[640px]">
          {/* Chat Header */}
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 bg-slate-50/70">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {botUsername ? `@${botUsername}` : '@RelayBridgeBot'}
              </div>
              <div className="text-xs text-slate-500">
                Always-active bot command &amp; inline menu engine
              </div>
            </div>
            <button
              type="button"
              onClick={() => void onResetHistory()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset Chat
            </button>
          </div>

          {/* Chat Feed */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 bg-slate-50/40">
            {history.map((msg) => {
              const isUser = msg.sender === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[88%] rounded-xl px-4 py-3 text-sm ${
                      isUser
                        ? 'bg-sky-600 text-white'
                        : 'bg-white border border-slate-200 text-slate-800'
                    }`}
                  >
                    {msg.forwardedFrom && (
                      <div className="mb-1.5 pb-1.5 border-b border-white/25 text-xs text-sky-100">
                        Forwarded from <span className="font-semibold">{msg.forwardedFrom.title}</span>
                        {msg.forwardedFrom.username ? ` (@${msg.forwardedFrom.username})` : ''}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap leading-relaxed">{msg.text}</div>
                  </div>

                  {/* Telegram Inline Keyboard Buttons */}
                  {!isUser && msg.inlineKeyboard && msg.inlineKeyboard.length > 0 && (
                    <div className="mt-1.5 w-full max-w-[88%] space-y-1.5">
                      {msg.inlineKeyboard.map((row, rowIdx) => (
                        <div
                          key={rowIdx}
                          className="grid gap-1.5"
                          style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                        >
                          {row.map((btn) => (
                            <button
                              key={btn.callbackData}
                              type="button"
                              disabled={busy}
                              onClick={() => void onClickCallback(btn.callbackData)}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-sky-700 hover:bg-sky-50 hover:border-sky-300 transition-colors truncate cursor-pointer"
                            >
                              {btn.text}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Telegram Menu Button Popover + Composer */}
          <div className="relative border-t border-slate-200 bg-white p-3">
            {menuOpen && (
              <div className="absolute bottom-full left-3 mb-2 w-80 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden z-20">
                <div className="border-b border-slate-100 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700">
                  Telegram Bot Menu Commands
                </div>
                <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
                  {commands.map((c) => (
                    <button
                      key={c.command}
                      type="button"
                      onClick={() => void handleCommandClick(c.command)}
                      className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-slate-50 cursor-pointer"
                    >
                      <span className="font-mono text-xs font-semibold text-sky-700">
                        /{c.command}
                      </span>
                      <span className="text-xs text-slate-500 truncate">{c.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  menuOpen
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-900 text-white hover:bg-slate-800'
                }`}
              >
                <Menu className="h-3.5 w-3.5" />
                Menu
              </button>

              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type /connections, /sources, @channel, or t.me/link..."
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:bg-white focus:outline-none"
              />

              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Send message"
                className="inline-flex items-center justify-center rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>

        {/* Right: Forward-a-Post Simulator + Live Source Burst Trigger */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          {/* Card 1: Forward any Channel Post to Bot */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Simulate Forwarding a Post to Bot
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Forward a post from any open/public or private channel into the bot to trigger the instant "Set as Source" / "Set as Target" / "Set as Backup" prompt.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-500">1-Click Sample Channels</div>
              <div className="flex flex-wrap gap-2">
                {SAMPLE_FORWARD_CHANNELS.map((sample) => (
                  <button
                    key={sample.username}
                    type="button"
                    disabled={busy}
                    onClick={() => void onForwardPost(sample)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 transition-colors cursor-pointer"
                  >
                    <Forward className="h-3.5 w-3.5" />
                    {sample.title}
                  </button>
                ))}
              </div>
            </div>

            <form onSubmit={handleForwardSubmit} className="space-y-3 pt-2 border-t border-slate-100">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  type="text"
                  value={fwdTitle}
                  onChange={(e) => setFwdTitle(e.target.value)}
                  placeholder="Channel Title"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
                />
                <input
                  type="text"
                  value={fwdUsername}
                  onChange={(e) => setFwdUsername(e.target.value)}
                  placeholder="@username (optional)"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={fwdKind}
                  onChange={(e) => setFwdKind(e.target.value as ChatKind)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800"
                >
                  <option value="channel">Channel</option>
                  <option value="supergroup">Supergroup</option>
                  <option value="group">Group</option>
                </select>
                <button
                  type="submit"
                  disabled={busy || !fwdTitle.trim()}
                  className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  Forward Custom Post to Bot
                </button>
              </div>
            </form>
          </div>

          {/* Card 2: Simulate Live Incoming Source Message */}
          <form
            onSubmit={handleSimDispatch}
            className="rounded-xl border border-slate-200 bg-white p-5 space-y-3.5 flex-1 flex flex-col justify-between"
          >
            <div className="space-y-3.5">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Trigger Live Incoming Source Post
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Simulate a video, file, or burst of posts arriving in a Source channel to verify your per-connection filters, caption rules, and rate-limit queue.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Source Channel
                </label>
                <select
                  value={simSourceId}
                  onChange={(e) => setSimSourceId(e.target.value)}
                  disabled={sources.length === 0}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 disabled:opacity-50"
                >
                  {sources.length === 0 ? (
                    <option value="">Register a Source channel first</option>
                  ) : (
                    sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} ({s.telegramChatId})
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Media</label>
                  <select
                    value={simMedia}
                    onChange={(e) => setSimMedia(e.target.value as MediaType)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900"
                  >
                    <option value="video">Video</option>
                    <option value="document">File / Doc</option>
                    <option value="photo">Photo</option>
                    <option value="audio">Audio</option>
                    <option value="text">Text Only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Size (MB)</label>
                  <input
                    type="number"
                    min={0}
                    max={2000}
                    value={simSizeMb}
                    onChange={(e) => setSimSizeMb(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-mono tabular-nums text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Burst Qty</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={simBurst}
                    onChange={(e) => setSimBurst(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-mono tabular-nums text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Caption / Text (leave empty to test "Only With Caption")
                </label>
                <input
                  type="text"
                  value={simCaption}
                  onChange={(e) => setSimCaption(e.target.value)}
                  placeholder="Optional caption..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-2 pt-2">
              {simFeedback && <div className="text-xs font-medium text-sky-700">{simFeedback}</div>}
              <button
                type="submit"
                disabled={sources.length === 0}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Zap className="h-3.5 w-3.5" />
                Dispatch Incoming Post to Live Queue
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
