import React, { useMemo, useState } from 'react';
import { ArrowRight, Plus, Search, Trash2 } from 'lucide-react';
import type {
  ChannelAccessMode,
  ChannelRole,
  ChatKind,
  Connection,
  SavedChannel,
} from '../types';

interface ChannelsViewProps {
  channels: SavedChannel[];
  connections: Connection[];
  onAddChannel: (payload: {
    telegramChatId: string;
    title: string;
    username?: string;
    kind: ChatKind;
    role: ChannelRole;
    accessMode: ChannelAccessMode;
    isBotAdmin?: boolean;
    userbotJoined?: boolean;
  }) => Promise<void>;
  onUpdateRole: (id: string, role: ChannelRole) => Promise<void>;
  onDeleteChannel: (id: string) => Promise<void>;
  onConnectSource: (sourceId: string) => void;
}

const ROLE_LABELS: Record<ChannelRole, string> = {
  source: 'Source',
  target: 'Target',
  backup: 'Backup',
  unassigned: 'Unassigned',
};

const ACCESS_LABELS: Record<ChannelAccessMode, string> = {
  userbot_open: 'Userbot Open Reader (no admin)',
  bot_admin: 'Bot Admin',
  forwarded_post: 'Captured via Forwarded Post',
  manual_link: 'Username / Link',
};

export const ChannelsView: React.FC<ChannelsViewProps> = ({
  channels,
  connections,
  onAddChannel,
  onUpdateRole,
  onDeleteChannel,
  onConnectSource,
}) => {
  const [roleFilter, setRoleFilter] = useState<'all' | ChannelRole>('all');
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  // Add channel form state
  const [chatInput, setChatInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [kind, setKind] = useState<ChatKind>('channel');
  const [role, setRole] = useState<ChannelRole>('source');
  const [accessMode, setAccessMode] = useState<ChannelAccessMode>('userbot_open');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return channels.filter((ch) => {
      if (roleFilter !== 'all' && ch.role !== roleFilter) return false;
      if (!q) return true;
      return (
        ch.title.toLowerCase().includes(q) ||
        ch.telegramChatId.toLowerCase().includes(q) ||
        (ch.username ?? '').toLowerCase().includes(q)
      );
    });
  }, [channels, roleFilter, search]);

  const counts = useMemo(() => {
    return {
      all: channels.length,
      source: channels.filter((c) => c.role === 'source').length,
      target: channels.filter((c) => c.role === 'target').length,
      backup: channels.filter((c) => c.role === 'backup').length,
      unassigned: channels.filter((c) => c.role === 'unassigned').length,
    };
  }, [channels]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!chatInput.trim()) {
      setFormError('Enter a @username, t.me link, or numeric chat ID (e.g. -1001928374650).');
      return;
    }
    setSubmitting(true);
    try {
      await onAddChannel({
        telegramChatId: chatInput.trim(),
        title: titleInput.trim() || chatInput.trim(),
        kind,
        role,
        accessMode,
        isBotAdmin: accessMode === 'bot_admin',
        userbotJoined: accessMode === 'userbot_open' || role === 'source',
      });
      setChatInput('');
      setTitleInput('');
      setShowAddForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save channel');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Action Row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Channels &amp; Sources
          </h1>
          <p className="mt-1 text-sm text-slate-600 max-w-2xl">
            Save any open or private Telegram channel or group as a Source, Target, or Backup. Saved Sources stay stored even before connecting them to a Target, and public sources can be read via Userbot without admin access.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm((prev) => !prev)}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {showAddForm ? 'Close Form' : 'Add Source / Channel'}
        </button>
      </div>

      {/* Inline Add Source / Channel Form */}
      {showAddForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 space-y-5"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Register Channel or Group</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Add by @username, https://t.me/ link, or numeric Telegram chat ID (-100...).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Channel @username, Link, or Chat ID
              </label>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="@channel_name or -1001928374650"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/15"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Display Title
              </label>
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                placeholder="e.g. Cinema HD Releases"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/15"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as ChannelRole)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/15"
              >
                <option value="source">Source (Read incoming posts)</option>
                <option value="target">Target (Receive forwarded posts)</option>
                <option value="backup">Backup Channel (Mirror / Failover)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Chat Type
              </label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ChatKind)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/15"
              >
                <option value="channel">Channel</option>
                <option value="supergroup">Supergroup</option>
                <option value="group">Group</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Access Mode
              </label>
              <select
                value={accessMode}
                onChange={(e) => setAccessMode(e.target.value as ChannelAccessMode)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600/15"
              >
                <option value="userbot_open">
                  Open / Public Channel — Read via Userbot (No Admin Rights Needed)
                </option>
                <option value="bot_admin">
                  Bot Added as Admin — Direct Bot API + Userbot Access
                </option>
                <option value="forwarded_post">
                  Forwarded Post Capture — Discovered by Forwarding a Post
                </option>
              </select>
            </div>
          </div>

          {formError && <p className="text-sm text-red-600">{formError}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {submitting ? 'Saving...' : 'Save Channel'}
            </button>
          </div>
        </form>
      )}

      {/* Filter Tabs + Search Bar */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 overflow-x-auto">
          {(
            [
              { key: 'all', label: `All (${counts.all})` },
              { key: 'source', label: `Sources (${counts.source})` },
              { key: 'target', label: `Targets (${counts.target})` },
              { key: 'backup', label: `Backups (${counts.backup})` },
              { key: 'unassigned', label: `Unassigned (${counts.unassigned})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setRoleFilter(tab.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                roleFilter === tab.key
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
            placeholder="Search title, @handle, or ID..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-none"
          />
        </div>
      </div>

      {/* High-Density Channel Registry Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <h3 className="text-base font-semibold text-slate-900">
              {channels.length === 0 ? 'No channels saved yet' : 'No channels match your filter'}
            </h3>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
              {channels.length === 0
                ? 'Add any public or private Source channel here, or forward a post from any channel inside the Bot Playground to assign it as Source or Target.'
                : 'Try switching the role filter or clearing the search box.'}
            </p>
            {channels.length === 0 && (
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 transition-colors cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                Add First Source Channel
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 pl-5 pr-4">Channel / Group</th>
                  <th className="py-3 px-4">Chat ID</th>
                  <th className="py-3 px-4">Access Method</th>
                  <th className="py-3 px-4">Role Assignment</th>
                  <th className="py-3 px-4 text-right">Connections</th>
                  <th className="py-3 pl-4 pr-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((ch) => {
                  const linkedCount = connections.filter(
                    (c) =>
                      c.sourceChannelId === ch.id ||
                      c.targetChannelId === ch.id ||
                      c.backupChannelId === ch.id,
                  ).length;

                  return (
                    <tr key={ch.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3.5 pl-5 pr-4">
                        <div className="font-medium text-slate-900">{ch.title}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                          <span>{ch.kind}</span>
                          {ch.username && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">@{ch.username}</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs text-slate-600 tabular-nums">
                        {ch.telegramChatId}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600">
                        <div>{ACCESS_LABELS[ch.accessMode]}</div>
                        <div className="text-slate-400 mt-0.5">
                          {ch.isBotAdmin ? 'Bot Admin' : 'No Admin Needed'} ·{' '}
                          {ch.userbotJoined ? 'Userbot Ready' : 'Bot Only'}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
                          {(['source', 'target', 'backup'] as const).map((r) => (
                            <button
                              key={r}
                              type="button"
                              onClick={() => void onUpdateRole(ch.id, r)}
                              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                                ch.role === r
                                  ? r === 'source'
                                    ? 'bg-sky-600 text-white'
                                    : r === 'target'
                                      ? 'bg-slate-900 text-white'
                                      : 'bg-amber-600 text-white'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              {ROLE_LABELS[r]}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                        {linkedCount}
                      </td>
                      <td className="py-3.5 pl-4 pr-5 text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          {ch.role === 'source' && (
                            <button
                              type="button"
                              onClick={() => onConnectSource(ch.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-sky-300 hover:text-sky-700 transition-colors whitespace-nowrap cursor-pointer"
                            >
                              Connect
                              <ArrowRight className="h-3 w-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void onDeleteChannel(ch.id)}
                            aria-label={`Delete ${ch.title}`}
                            className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
