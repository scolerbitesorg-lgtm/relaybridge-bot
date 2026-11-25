import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Connection,
  ConnectionFilterSettings,
  FindReplaceRule,
  MediaType,
  SavedChannel,
} from '../types';

interface ConnectionsViewProps {
  connections: Connection[];
  channels: SavedChannel[];
  initialSourceIdForModal?: string | null;
  openCreateModalSignal: number;
  onClearInitialSource: () => void;
  onCreateConnection: (payload: {
    name?: string;
    sourceChannelId: string;
    targetChannelId: string;
    backupChannelId?: string | null;
    filters?: Partial<ConnectionFilterSettings>;
  }) => Promise<void>;
  onUpdateConnection: (
    id: string,
    patch: Partial<{
      name: string;
      sourceChannelId: string;
      targetChannelId: string;
      backupChannelId: string | null;
      enabled: boolean;
      filters: Partial<ConnectionFilterSettings>;
    }>,
  ) => Promise<void>;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestDispatch: (payload: {
    sourceChannelId: string;
    mediaType: MediaType;
    caption?: string;
    fileSizeMb?: number;
  }) => Promise<void>;
  onGoToChannels: () => void;
  onGoToPlayground: () => void;
}

const MEDIA_OPTIONS: Array<{ key: MediaType; label: string }> = [
  { key: 'video', label: 'Videos' },
  { key: 'document', label: 'Files / Docs' },
  { key: 'photo', label: 'Photos' },
  { key: 'audio', label: 'Audio' },
  { key: 'voice', label: 'Voice' },
  { key: 'animation', label: 'GIFs' },
  { key: 'text', label: 'Text' },
  { key: 'sticker', label: 'Stickers' },
  { key: 'poll', label: 'Polls' },
];

export const ConnectionsView: React.FC<ConnectionsViewProps> = ({
  connections,
  channels,
  initialSourceIdForModal,
  openCreateModalSignal,
  onClearInitialSource,
  onCreateConnection,
  onUpdateConnection,
  onDeleteConnection,
  onTestDispatch,
  onGoToChannels,
  onGoToPlayground,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingConnId, setEditingConnId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  // Create modal state
  const [newName, setNewName] = useState('');
  const [newSourceId, setNewSourceId] = useState('');
  const [newTargetId, setNewTargetId] = useState('');
  const [newBackupId, setNewBackupId] = useState('');
  const [newPreset, setNewPreset] = useState<'all' | 'video_caption' | 'video_files'>('video_files');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');

  // Track external signal to open Create Connection modal
  React.useEffect(() => {
    if (openCreateModalSignal > 0) {
      if (initialSourceIdForModal) {
        setNewSourceId(initialSourceIdForModal);
      } else {
        const firstSource = channels.find((c) => c.role === 'source') ?? channels[0];
        setNewSourceId(firstSource?.id ?? '');
      }
      const firstTarget =
        channels.find((c) => c.role === 'target' && c.id !== initialSourceIdForModal) ??
        channels.find((c) => c.id !== initialSourceIdForModal);
      setNewTargetId(firstTarget?.id ?? '');
      const firstBackup = channels.find((c) => c.role === 'backup');
      setNewBackupId(firstBackup?.id ?? '');
      setNewName('');
      setCreateErr('');
      setShowCreateModal(true);
    }
  }, [openCreateModalSignal, initialSourceIdForModal, channels]);

  const channelMap = useMemo(() => {
    const map = new Map<string, SavedChannel>();
    for (const c of channels) map.set(c.id, c);
    return map;
  }, [channels]);

  const totals = useMemo(() => {
    return connections.reduce(
      (acc, c) => {
        if (c.enabled) acc.active += 1;
        acc.forwarded += c.stats.forwardedCount;
        acc.filtered += c.stats.filteredOutCount;
        acc.backup += c.stats.backupCount;
        return acc;
      },
      { active: 0, forwarded: 0, filtered: 0, backup: 0 },
    );
  }, [connections]);

  const filteredConnections = useMemo(() => {
    const q = search.trim().toLowerCase();
    return connections.filter((conn) => {
      if (statusFilter === 'active' && !conn.enabled) return false;
      if (statusFilter === 'paused' && conn.enabled) return false;
      if (!q) return true;
      const src = channelMap.get(conn.sourceChannelId)?.title ?? '';
      const tgt = channelMap.get(conn.targetChannelId)?.title ?? '';
      return (
        conn.name.toLowerCase().includes(q) ||
        src.toLowerCase().includes(q) ||
        tgt.toLowerCase().includes(q)
      );
    });
  }, [connections, statusFilter, search, channelMap]);

  const editingConn = useMemo(
    () => connections.find((c) => c.id === editingConnId) ?? null,
    [connections, editingConnId],
  );

  const openNewModal = () => {
    const firstSource = channels.find((c) => c.role === 'source') ?? channels[0];
    const firstTarget =
      channels.find((c) => c.role === 'target' && c.id !== firstSource?.id) ??
      channels.find((c) => c.id !== firstSource?.id);
    const firstBackup = channels.find((c) => c.role === 'backup');
    setNewSourceId(firstSource?.id ?? '');
    setNewTargetId(firstTarget?.id ?? '');
    setNewBackupId(firstBackup?.id ?? '');
    setNewName('');
    setCreateErr('');
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateErr('');
    if (!newSourceId || !newTargetId) {
      setCreateErr('Select both a Source channel and a Target channel.');
      return;
    }
    if (newSourceId === newTargetId) {
      setCreateErr('Source and Target must be different channels.');
      return;
    }

    let filters: Partial<ConnectionFilterSettings> | undefined;
    if (newPreset === 'video_caption') {
      filters = {
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
        backupMode: newBackupId ? 'mirror' : 'off',
      };
    } else if (newPreset === 'video_files') {
      filters = {
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
        backupMode: newBackupId ? 'failover' : 'off',
      };
    } else {
      filters = {
        allowedMedia: {
          video: true,
          document: true,
          photo: true,
          audio: true,
          voice: true,
          animation: true,
          sticker: false,
          text: true,
          poll: true,
        },
        onlyWithCaption: false,
        backupMode: newBackupId ? 'failover' : 'off',
      };
    }

    setCreating(true);
    try {
      await onCreateConnection({
        name: newName.trim() || undefined,
        sourceChannelId: newSourceId,
        targetChannelId: newTargetId,
        backupChannelId: newBackupId || null,
        filters,
      });
      setShowCreateModal(false);
      onClearInitialSource();
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Failed to create connection');
    } finally {
      setCreating(false);
    }
  };

  const handleQuickTest = async (conn: Connection) => {
    await onTestDispatch({
      sourceChannelId: conn.sourceChannelId,
      mediaType: 'video',
      caption: `Sample 1080p release from ${channelMap.get(conn.sourceChannelId)?.title ?? 'Source'}`,
      fileSizeMb: 42.5,
    });
    setToast(`Dispatched test video through "${conn.name}"`);
    setTimeout(() => setToast(''), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Page Title */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Forwarding Connections
          </h1>
          <p className="mt-1 text-sm text-slate-600 max-w-2xl">
            Manage unlimited live Source → Target (+ Optional Backup) pipelines. Configure separate media filters, caption rules, link stripping, and Userbot routing per connection.
          </p>
        </div>
        {toast && <div className="text-xs font-medium text-emerald-700">{toast}</div>}
      </div>

      {/* 4-Column Flat KPI Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Live Connections</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totals.active}
            <span className="text-sm font-normal text-slate-400"> / {connections.length}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">Real-time listeners armed</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Messages Forwarded</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-emerald-700 tabular-nums">
            {totals.forwarded}
          </div>
          <div className="mt-1 text-xs text-slate-500">Delivered via Userbot &amp; Bot API</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Filtered by Rules</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-700 tabular-nums">
            {totals.filtered}
          </div>
          <div className="mt-1 text-xs text-slate-500">Blocked by media, caption, or dedupe</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Backup Deliveries</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-sky-700 tabular-nums">
            {totals.backup}
          </div>
          <div className="mt-1 text-xs text-slate-500">Mirrored or failed over cleanly</div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          {(
            [
              { key: 'all', label: `All (${connections.length})` },
              { key: 'active', label: `Active (${totals.active})` },
              { key: 'paused', label: `Paused (${connections.length - totals.active})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                statusFilter === tab.key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search connection or channel..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none"
          />
        </div>
      </div>

      {/* Connections List */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {filteredConnections.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <h3 className="text-base font-semibold text-slate-900">
              {connections.length === 0
                ? 'No forwarding connections created yet'
                : 'No connections match your current filter'}
            </h3>
            <p className="mx-auto mt-1.5 max-w-lg text-sm text-slate-500">
              {channels.length < 2
                ? 'Start by saving a Source channel and a Target channel (or forward any post inside the Bot Playground to register channels instantly).'
                : 'Link any saved Source channel to a Target channel and optional Backup channel, then customize per-connection media and caption filters.'}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              {channels.length >= 2 ? (
                <button
                  type="button"
                  onClick={openNewModal}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 transition-colors cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  Create First Connection
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onGoToChannels}
                    className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 transition-colors cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                    Add Source &amp; Target Channels
                  </button>
                  <button
                    type="button"
                    onClick={onGoToPlayground}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    Open Bot Playground
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredConnections.map((conn) => {
              const source = channelMap.get(conn.sourceChannelId);
              const target = channelMap.get(conn.targetChannelId);
              const backup = conn.backupChannelId ? channelMap.get(conn.backupChannelId) : null;
              const activeMedia = MEDIA_OPTIONS.filter((m) => conn.filters.allowedMedia[m.key]).map(
                (m) => m.label,
              );

              return (
                <div
                  key={conn.id}
                  className="p-5 hover:bg-slate-50/60 transition-colors flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 className="text-base font-semibold text-slate-900 truncate">
                        {conn.name}
                      </h3>
                      <span
                        className={`text-xs font-medium ${
                          conn.enabled ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {conn.enabled ? 'Active' : 'Paused'}
                      </span>
                    </div>

                    {/* Clean Route Line */}
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                      <span className="font-medium text-slate-900">
                        {source?.title ?? 'Unknown Source'}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span className="font-medium text-slate-900">
                        {target?.title ?? 'Unknown Target'}
                      </span>
                      {backup && (
                        <span className="text-xs text-slate-500">
                          + Backup: <span className="text-slate-700 font-medium">{backup.title}</span> ({conn.filters.backupMode})
                        </span>
                      )}
                    </div>

                    {/* Unboxed Metadata Summary (Zero-Pill Discipline) */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span>Media: {activeMedia.length > 0 ? activeMedia.join(', ') : 'None'}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {conn.filters.onlyWithCaption ? 'Caption Required' : 'Caption Optional'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{conn.filters.forwardMode === 'copy' ? 'Copy Mode' : 'Forward Tag'}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {conn.filters.preferUserbot ? 'Userbot MTProto' : 'Bot API'}
                      </span>
                      {conn.filters.stripLinks && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Links Stripped</span>
                        </>
                      )}
                      {conn.filters.deduplicate && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Dedupe On</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Stats + Controls */}
                  <div className="flex flex-wrap items-center gap-4 shrink-0">
                    <div className="flex items-center gap-4 text-right font-mono text-xs tabular-nums border-r border-slate-200 pr-4">
                      <div>
                        <div className="text-slate-900 font-semibold">
                          {conn.stats.forwardedCount}
                        </div>
                        <div className="text-slate-400 font-sans">sent</div>
                      </div>
                      <div>
                        <div className="text-slate-600 font-semibold">
                          {conn.stats.filteredOutCount}
                        </div>
                        <div className="text-slate-400 font-sans">filtered</div>
                      </div>
                      {backup && (
                        <div>
                          <div className="text-sky-700 font-semibold">
                            {conn.stats.backupCount}
                          </div>
                          <div className="text-slate-400 font-sans">backup</div>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleQuickTest(conn)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:border-sky-300 hover:text-sky-700 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <Send className="h-3.5 w-3.5" />
                        Test Post
                      </button>

                      <button
                        type="button"
                        onClick={() => setEditingConnId(conn.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <Settings className="h-3.5 w-3.5" />
                        Settings
                      </button>

                      <button
                        type="button"
                        onClick={() => void onUpdateConnection(conn.id, { enabled: !conn.enabled })}
                        aria-label={conn.enabled ? 'Pause connection' : 'Resume connection'}
                        className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        {conn.enabled ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5 text-emerald-600" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => void onDeleteConnection(conn.id)}
                        aria-label={`Delete ${conn.name}`}
                        className="inline-flex items-center justify-center rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Connection Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Create New Connection</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Link a Source channel to a Target channel and optional Backup channel.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCreateModal(false);
                  onClearInitialSource();
                }}
                aria-label="Close modal"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {channels.length < 2 ? (
              <div className="py-4 space-y-4">
                <p className="text-sm text-slate-600">
                  You need at least 2 saved channels (1 Source and 1 Target) before creating a connection. Add them in Channels &amp; Sources or forward posts inside the Bot Playground.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 cursor-pointer"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      onGoToChannels();
                    }}
                    className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 cursor-pointer"
                  >
                    Go to Channels
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Connection Name (optional)
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Auto-generated from Source → Target if blank"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Source Channel / Group
                  </label>
                  <select
                    value={newSourceId}
                    onChange={(e) => setNewSourceId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                  >
                    {channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        [{ch.role.toUpperCase()}] {ch.title} ({ch.telegramChatId})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Target Channel / Group
                  </label>
                  <select
                    value={newTargetId}
                    onChange={(e) => setNewTargetId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                  >
                    {channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        [{ch.role.toUpperCase()}] {ch.title} ({ch.telegramChatId})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Backup Channel (optional — failover or dual mirror)
                  </label>
                  <select
                    value={newBackupId}
                    onChange={(e) => setNewBackupId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                  >
                    <option value="">No backup channel</option>
                    {channels
                      .filter((c) => c.id !== newSourceId && c.id !== newTargetId)
                      .map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          [{ch.role.toUpperCase()}] {ch.title} ({ch.telegramChatId})
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Initial Filter Preset
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        { key: 'video_files', label: 'Videos & Files' },
                        { key: 'video_caption', label: 'Video + Caption' },
                        { key: 'all', label: 'All Media + Text' },
                      ] as const
                    ).map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => setNewPreset(preset.key)}
                        className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                          newPreset === preset.key
                            ? 'border-sky-600 bg-sky-50 text-sky-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {createErr && <p className="text-xs text-red-600">{createErr}</p>}

                <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      onClearInitialSource();
                    }}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer"
                  >
                    {creating ? 'Creating...' : 'Create Connection'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Per-Connection Settings Drawer */}
      {editingConn && (
        <ConnectionSettingsDrawer
          connection={editingConn}
          channels={channels}
          onClose={() => setEditingConnId(null)}
          onSave={async (patch) => {
            await onUpdateConnection(editingConn.id, patch);
            setEditingConnId(null);
            setToast(`Updated settings for "${patch.name ?? editingConn.name}"`);
            setTimeout(() => setToast(''), 2500);
          }}
        />
      )}
    </div>
  );
};

interface ConnectionSettingsDrawerProps {
  connection: Connection;
  channels: SavedChannel[];
  onClose: () => void;
  onSave: (patch: {
    name: string;
    backupChannelId: string | null;
    filters: ConnectionFilterSettings;
  }) => Promise<void>;
}

const ConnectionSettingsDrawer: React.FC<ConnectionSettingsDrawerProps> = ({
  connection,
  channels,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState(connection.name);
  const [backupChannelId, setBackupChannelId] = useState<string>(connection.backupChannelId ?? '');
  const [filters, setFilters] = useState<ConnectionFilterSettings>(() =>
    structuredClone(connection.filters),
  );
  const [whitelistText, setWhitelistText] = useState(connection.filters.keywordWhitelist.join(', '));
  const [blacklistText, setBlacklistText] = useState(connection.filters.keywordBlacklist.join(', '));
  const [newFind, setNewFind] = useState('');
  const [newReplace, setNewReplace] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleMedia = (key: MediaType) => {
    setFilters((prev) => ({
      ...prev,
      allowedMedia: {
        ...prev.allowedMedia,
        [key]: !prev.allowedMedia[key],
      },
    }));
  };

  const applyPreset = (preset: 'video_caption' | 'videos_files' | 'all') => {
    if (preset === 'video_caption') {
      setFilters((prev) => ({
        ...prev,
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
      }));
    } else if (preset === 'videos_files') {
      setFilters((prev) => ({
        ...prev,
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
      }));
    } else {
      setFilters((prev) => ({
        ...prev,
        allowedMedia: {
          video: true,
          document: true,
          photo: true,
          audio: true,
          voice: true,
          animation: true,
          sticker: true,
          text: true,
          poll: true,
        },
        onlyWithCaption: false,
      }));
    }
  };

  const addReplaceRule = () => {
    if (!newFind.trim()) return;
    const rule: FindReplaceRule = {
      id: `fr_${Date.now()}`,
      find: newFind,
      replace: newReplace,
    };
    setFilters((prev) => ({ ...prev, findReplace: [...prev.findReplace, rule] }));
    setNewFind('');
    setNewReplace('');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const nextFilters: ConnectionFilterSettings = {
        ...filters,
        keywordWhitelist: whitelistText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        keywordBlacklist: blacklistText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await onSave({
        name: name.trim() || connection.name,
        backupChannelId: backupChannelId || null,
        filters: nextFilters,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40">
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl border-l border-slate-200">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Connection Settings</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Changes apply exclusively to this Source → Target pipeline in real time.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Drawer Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* General */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Connection Label
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Backup Channel
              </label>
              <select
                value={backupChannelId}
                onChange={(e) => setBackupChannelId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
              >
                <option value="">None</option>
                {channels
                  .filter(
                    (c) => c.id !== connection.sourceChannelId && c.id !== connection.targetChannelId,
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} ({c.telegramChatId})
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* Quick Presets */}
          <div className="space-y-2 border-t border-slate-100 pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Allowed Media Types</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => applyPreset('video_caption')}
                  className="text-xs font-medium text-sky-700 hover:underline cursor-pointer"
                >
                  Only Videos + Caption
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => applyPreset('videos_files')}
                  className="text-xs font-medium text-sky-700 hover:underline cursor-pointer"
                >
                  Videos &amp; Files
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => applyPreset('all')}
                  className="text-xs font-medium text-slate-600 hover:underline cursor-pointer"
                >
                  Select All
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              {MEDIA_OPTIONS.map((item) => {
                const active = filters.allowedMedia[item.key];
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleMedia(item.key)}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'border-sky-600 bg-sky-50 text-sky-900'
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className="font-mono text-[11px]">{active ? 'ON' : 'OFF'}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Caption, Forward Mode & Transport Rules */}
          <div className="space-y-3 border-t border-slate-100 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">Caption, Mode &amp; Routing</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.onlyWithCaption}
                  onChange={(e) => setFilters({ ...filters, onlyWithCaption: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="font-medium text-slate-900">Require caption on media</span>
                  <span className="block text-xs text-slate-500">
                    Skip videos/files/photos that have no caption
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.preferUserbot}
                  onChange={(e) => setFilters({ ...filters, preferUserbot: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="font-medium text-slate-900">Prefer Userbot MTProto</span>
                  <span className="block text-xs text-slate-500">
                    Best for large videos/files (2GB+) &amp; open channels
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.stripLinks}
                  onChange={(e) => setFilters({ ...filters, stripLinks: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="font-medium text-slate-900">Strip external URLs &amp; t.me links</span>
                  <span className="block text-xs text-slate-500">
                    Clean promotional URLs before sending
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.stripUsernames}
                  onChange={(e) => setFilters({ ...filters, stripUsernames: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="font-medium text-slate-900">Strip @usernames</span>
                  <span className="block text-xs text-slate-500">
                    Remove channel handles from captions
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.stripCaption}
                  onChange={(e) => setFilters({ ...filters, stripCaption: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="font-medium text-slate-900">Remove original caption</span>
                  <span className="block text-xs text-slate-500">
                    Send media cleanly without source text
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.deduplicate}
                  onChange={(e) => setFilters({ ...filters, deduplicate: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="font-medium text-slate-900">Prevent duplicate files</span>
                  <span className="block text-xs text-slate-500">
                    Ignore already-forwarded file hashes
                  </span>
                </span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Delivery Mode
                </label>
                <select
                  value={filters.forwardMode}
                  onChange={(e) =>
                    setFilters({ ...filters, forwardMode: e.target.value as 'copy' | 'forward' })
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                >
                  <option value="copy">Copy (Clean post, no "Forwarded from" header)</option>
                  <option value="forward">Forward (Keep original "Forwarded from" tag)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Backup Channel Behavior
                </label>
                <select
                  value={filters.backupMode}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      backupMode: e.target.value as 'off' | 'failover' | 'mirror',
                    })
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                >
                  <option value="failover">Failover (Send to Backup if Target errors)</option>
                  <option value="mirror">Mirror (Always send to Target + Backup)</option>
                  <option value="off">Off</option>
                </select>
              </div>
            </div>
          </div>

          {/* Caption Prefix/Suffix & Size/Delay */}
          <div className="space-y-4 border-t border-slate-100 pt-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Caption Template, Keywords &amp; Limits
            </h3>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Caption Prefix (Top)
                </label>
                <input
                  type="text"
                  value={filters.captionPrefix}
                  onChange={(e) => setFilters({ ...filters, captionPrefix: e.target.value })}
                  placeholder="Optional header line..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Caption Suffix (Bottom)
                </label>
                <input
                  type="text"
                  value={filters.captionSuffix}
                  onChange={(e) => setFilters({ ...filters, captionSuffix: e.target.value })}
                  placeholder="e.g. Join @MyTargetChannel"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Keyword Whitelist (comma-separated)
                </label>
                <input
                  type="text"
                  value={whitelistText}
                  onChange={(e) => setWhitelistText(e.target.value)}
                  placeholder="e.g. 1080p, 4K, Hindi"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Keyword Blacklist (comma-separated)
                </label>
                <input
                  type="text"
                  value={blacklistText}
                  onChange={(e) => setBlacklistText(e.target.value)}
                  placeholder="e.g. promo, betting, ad"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Min Size (MB)
                </label>
                <input
                  type="number"
                  min={0}
                  max={4000}
                  value={filters.minFileSizeMb}
                  onChange={(e) =>
                    setFilters({ ...filters, minFileSizeMb: Math.max(0, Number(e.target.value)) })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Max Size (MB)
                </label>
                <input
                  type="number"
                  min={0}
                  max={4000}
                  value={filters.maxFileSizeMb}
                  onChange={(e) =>
                    setFilters({ ...filters, maxFileSizeMb: Math.max(0, Number(e.target.value)) })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Delay (sec)
                </label>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={filters.delaySeconds}
                  onChange={(e) =>
                    setFilters({ ...filters, delaySeconds: Math.max(0, Number(e.target.value)) })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
                />
              </div>
            </div>

            {/* Find & Replace Rules */}
            <div className="space-y-2 pt-1">
              <label className="block text-xs font-medium text-slate-700">
                Find &amp; Replace Caption Rules
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newFind}
                  onChange={(e) => setNewFind(e.target.value)}
                  placeholder="Find text..."
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
                />
                <input
                  type="text"
                  value={newReplace}
                  onChange={(e) => setNewReplace(e.target.value)}
                  placeholder="Replace with..."
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
                />
                <button
                  type="button"
                  onClick={addReplaceRule}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  Add Rule
                </button>
              </div>
              {filters.findReplace.length > 0 && (
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-xs">
                  {filters.findReplace.map((r) => (
                    <div key={r.id} className="flex items-center justify-between px-3 py-2">
                      <span className="font-mono text-slate-700">
                        "{r.find}" → "{r.replace}"
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setFilters({
                            ...filters,
                            findReplace: filters.findReplace.filter((x) => x.id !== r.id),
                          })
                        }
                        className="text-slate-400 hover:text-red-600 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
