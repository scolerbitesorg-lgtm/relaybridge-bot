import React, { useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { DeliveryLog, QueueSnapshot, RateLimitConfig, SavedChannel } from '../types';

interface QueueMonitorViewProps {
  queue: QueueSnapshot;
  rateLimit: RateLimitConfig;
  logs: DeliveryLog[];
  channels: SavedChannel[];
  onUpdateRateLimit: (patch: Partial<RateLimitConfig>) => Promise<void>;
  onSimulateFloodWait: (channelId: string, seconds: number) => Promise<void>;
  onClearLogs: () => Promise<void>;
}

const STATUS_META: Record<
  DeliveryLog['status'],
  { label: string; textClass: string }
> = {
  delivered: { label: 'Delivered', textClass: 'text-emerald-700' },
  backup_delivered: { label: 'Backup Delivered', textClass: 'text-sky-700' },
  filtered: { label: 'Filtered Out', textClass: 'text-slate-500' },
  queued: { label: 'Queued', textClass: 'text-slate-700' },
  rate_limited: { label: 'FloodWait Backoff', textClass: 'text-amber-700' },
  failed: { label: 'Failed', textClass: 'text-red-700' },
};

export const QueueMonitorView: React.FC<QueueMonitorViewProps> = ({
  queue,
  rateLimit,
  logs,
  channels,
  onUpdateRateLimit,
  onSimulateFloodWait,
  onClearLogs,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | DeliveryLog['status']>('all');
  const [globalMax, setGlobalMax] = useState(rateLimit.globalMaxPerSecond);
  const [chatSec, setChatSec] = useState(rateLimit.perChatMaxPerSecond);
  const [chatMin, setChatMin] = useState(rateLimit.perChatMaxPerMinute);
  const [maxRetries, setMaxRetries] = useState(rateLimit.maxRetries);
  const [autoBackoff, setAutoBackoff] = useState(rateLimit.autoFloodBackoff);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');

  const targetChannels = useMemo(
    () => channels.filter((c) => c.role === 'target' || c.role === 'backup'),
    [channels],
  );
  const [floodTargetId, setFloodTargetId] = useState<string>('');
  const [floodSeconds, setFloodSeconds] = useState<number>(8);

  const filteredLogs = useMemo(() => {
    if (statusFilter === 'all') return logs;
    return logs.filter((l) => l.status === statusFilter);
  }, [logs, statusFilter]);

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPolicy(true);
    setSavedNotice('');
    try {
      await onUpdateRateLimit({
        globalMaxPerSecond: globalMax,
        perChatMaxPerSecond: chatSec,
        perChatMaxPerMinute: chatMin,
        maxRetries,
        autoFloodBackoff: autoBackoff,
      });
      setSavedNotice('Rate-limit policy saved');
      setTimeout(() => setSavedNotice(''), 2500);
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleTriggerFlood = async () => {
    const selectedId = floodTargetId || targetChannels[0]?.id;
    if (!selectedId) return;
    await onSimulateFloodWait(selectedId, floodSeconds);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Rate Limiter &amp; Delivery Queue
        </h1>
        <p className="mt-1 text-sm text-slate-600 max-w-2xl">
          Enforces Telegram global and per-chat pacing with isolated per-chat FLOOD_WAIT backoff, automatic retry, and backup channel failover so the bot never freezes under heavy video bursts.
        </p>
      </div>

      {/* Flat 4-Column KPI Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Queue Pending / Active</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {queue.pendingCount}{' '}
            <span className="text-sm font-normal text-slate-400">/ {queue.processingCount}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">Non-blocking async worker pool</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Global Token Budget</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {queue.globalTokensAvailable}
            <span className="text-sm font-normal text-slate-400">
              /{queue.globalMaxPerSecond} s
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500">Messages/second sliding window</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Total Delivered</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-emerald-700 tabular-nums">
            {queue.totalProcessed}
          </div>
          <div className="mt-1 text-xs text-slate-500">Across all live connections</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">FloodWait Auto-Recoveries</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
            {queue.totalRateLimited}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Active chat cooldowns: {queue.activeFloodWaits.length}
          </div>
        </div>
      </div>

      {/* Rate Limit Policy + FloodWait Isolation Tester */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        <form
          onSubmit={handleSavePolicy}
          className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Adaptive Pacing Policy</h2>
            {savedNotice && <span className="text-xs font-medium text-emerald-700">{savedNotice}</span>}
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Global / sec
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={globalMax}
                onChange={(e) => setGlobalMax(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Per-Chat / sec
              </label>
              <input
                type="number"
                min={1}
                max={5}
                value={chatSec}
                onChange={(e) => setChatSec(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Per-Chat / min
              </label>
              <input
                type="number"
                min={1}
                max={60}
                value={chatMin}
                onChange={(e) => setChatMin(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Max Retries
              </label>
              <input
                type="number"
                min={0}
                max={10}
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-sky-600 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={autoBackoff}
                onChange={(e) => setAutoBackoff(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
              />
              Isolate FLOOD_WAIT per target chat (other channels keep running)
            </label>

            <button
              type="submit"
              disabled={savingPolicy}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              {savingPolicy ? 'Saving...' : 'Save Policy'}
            </button>
          </div>
        </form>

        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 flex flex-col justify-between space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">FloodWait Isolation Monitor</h2>
            <p className="mt-1 text-xs text-slate-500">
              When Telegram returns a 429 retry_after on one destination chat, only that chat pauses while all other connections continue delivering immediately.
            </p>

            {queue.activeFloodWaits.length > 0 ? (
              <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-amber-200 bg-amber-50/50">
                {queue.activeFloodWaits.map((fw) => (
                  <div
                    key={fw.chatId}
                    className="flex items-center justify-between px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-amber-900 truncate">{fw.chatTitle}</span>
                    <span className="font-mono text-amber-800 tabular-nums shrink-0 ml-2">
                      Resumes in {fw.remainingSeconds}s
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
                All target chats operating normally — zero active cooldown windows.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
            <select
              value={floodTargetId || targetChannels[0]?.id || ''}
              onChange={(e) => setFloodTargetId(e.target.value)}
              disabled={targetChannels.length === 0}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-800 focus:border-sky-600 focus:outline-none disabled:opacity-50"
            >
              {targetChannels.length === 0 ? (
                <option value="">Add a Target channel first</option>
              ) : (
                targetChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))
              )}
            </select>
            <input
              type="number"
              min={2}
              max={30}
              value={floodSeconds}
              onChange={(e) => setFloodSeconds(Number(e.target.value))}
              className="w-16 rounded-lg border border-slate-300 px-2 py-2 text-xs font-mono tabular-nums text-slate-900"
              aria-label="FloodWait seconds"
            />
            <button
              type="button"
              onClick={() => void handleTriggerFlood()}
              disabled={targetChannels.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Test Backoff
            </button>
          </div>
        </div>
      </div>

      {/* Live Delivery Log Table */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 overflow-x-auto">
            {(
              [
                { key: 'all', label: `All (${logs.length})` },
                { key: 'delivered', label: 'Delivered' },
                { key: 'backup_delivered', label: 'Backup' },
                { key: 'filtered', label: 'Filtered' },
                { key: 'rate_limited', label: 'Rate Limited' },
                { key: 'failed', label: 'Failed' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === tab.key
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {logs.length > 0 && (
            <button
              type="button"
              onClick={() => void onClearLogs()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-red-600 hover:border-red-200 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear Log History
            </button>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {filteredLogs.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm font-medium text-slate-900">No delivery events yet</p>
              <p className="mt-1 text-xs text-slate-500">
                When posts arrive in any active Source channel (or when you run a test dispatch from Connections / Bot Playground), live delivery and filter results appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 pl-5 pr-3">Time</th>
                    <th className="py-2.5 px-3">Pipeline</th>
                    <th className="py-2.5 px-3">Media &amp; Caption</th>
                    <th className="py-2.5 px-3">Transport</th>
                    <th className="py-2.5 px-3">Outcome</th>
                    <th className="py-2.5 pl-3 pr-5 text-right">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredLogs.map((log) => {
                    const meta = STATUS_META[log.status];
                    const timeStr = new Date(log.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    });
                    return (
                      <tr key={log.id} className="hover:bg-slate-50/70">
                        <td className="py-3 pl-5 pr-3 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                          {timeStr}
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-medium text-slate-900">{log.connectionName}</div>
                          <div className="text-slate-500 mt-0.5">
                            {log.sourceTitle} → {log.targetTitle}
                          </div>
                        </td>
                        <td className="py-3 px-3 max-w-xs">
                          <div className="text-slate-800 font-medium">
                            {log.mediaType}
                            {log.fileName ? ` · ${log.fileName}` : ''}
                            {typeof log.fileSizeMb === 'number'
                              ? ` · ${log.fileSizeMb.toFixed(1)} MB`
                              : ''}
                          </div>
                          {log.captionPreview && (
                            <div className="truncate text-slate-500 mt-0.5">{log.captionPreview}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-600 whitespace-nowrap">
                          {log.transport === 'userbot'
                            ? 'Userbot MTProto'
                            : log.transport === 'bot_api'
                              ? 'Bot API'
                              : 'Queue Sim'}
                        </td>
                        <td className="py-3 px-3">
                          <div className={`font-medium ${meta.textClass}`}>{meta.label}</div>
                          <div className="text-slate-500 mt-0.5 max-w-xs truncate">{log.detail}</div>
                        </td>
                        <td className="py-3 pl-3 pr-5 text-right font-mono text-slate-600 tabular-nums whitespace-nowrap">
                          {log.latencyMs} ms
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
    </div>
  );
};
