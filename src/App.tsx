import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Code2,
  GitBranch,
  Lock,
  Menu,
  Plus,
  Radio,
  X,
} from 'lucide-react';
import { api, getAuthToken, setAuthToken } from './api';
import { BotPlaygroundView } from './components/BotPlaygroundView';
import { ChannelsView } from './components/ChannelsView';
import { ConnectionsView } from './components/ConnectionsView';
import { DeploymentView } from './components/DeploymentView';
import { QueueMonitorView } from './components/QueueMonitorView';
import type {
  BotChatMessage,
  BotCommandInfo,
  Connection,
  DeliveryLog,
  EngineStatus,
  QueueSnapshot,
  RateLimitConfig,
  SavedChannel,
} from './types';

type NavSection = 'connections' | 'channels' | 'playground' | 'queue' | 'deployment';

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'connections', label: 'Connections', icon: GitBranch },
  { id: 'channels', label: 'Channels & Sources', icon: Radio },
  { id: 'playground', label: 'Bot Playground', icon: Bot },
  { id: 'queue', label: 'Rate Limiter & Queue', icon: Activity },
  { id: 'deployment', label: 'Deployment & Code', icon: Code2 },
];

const DEFAULT_QUEUE: QueueSnapshot = {
  pendingCount: 0,
  processingCount: 0,
  globalTokensAvailable: 25,
  globalMaxPerSecond: 25,
  activeFloodWaits: [],
  totalProcessed: 0,
  totalRateLimited: 0,
  totalErrors: 0,
};

const DEFAULT_ENGINE: EngineStatus = {
  botApiConfigured: false,
  botApiRunning: false,
  userbotConfigured: false,
  userbotRunning: false,
  adminRestrictionEnabled: false,
  passcodeProtected: false,
  uptimeSeconds: 0,
};

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  globalMaxPerSecond: 25,
  perChatMaxPerSecond: 1,
  perChatMaxPerMinute: 18,
  maxRetries: 3,
  autoFloodBackoff: true,
};

export default function App() {
  const [section, setSection] = useState<NavSection>('connections');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Auth gate state (only shown when server has DASHBOARD_PASSCODE configured)
  const [needsAuth, setNeedsAuth] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authError, setAuthError] = useState('');

  // Core workspace state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [channels, setChannels] = useState<SavedChannel[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [logs, setLogs] = useState<DeliveryLog[]>([]);
  const [rateLimit, setRateLimit] = useState<RateLimitConfig>(DEFAULT_RATE_LIMIT);
  const [queue, setQueue] = useState<QueueSnapshot>(DEFAULT_QUEUE);
  const [engine, setEngine] = useState<EngineStatus>(DEFAULT_ENGINE);
  const [playgroundHistory, setPlaygroundHistory] = useState<BotChatMessage[]>([]);
  const [commands, setCommands] = useState<BotCommandInfo[]>([]);

  // Cross-view trigger to open Create Connection modal
  const [openCreateSignal, setOpenCreateSignal] = useState(0);
  const [prefillSourceId, setPrefillSourceId] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.bootstrap();
      setChannels(data.channels);
      setConnections(data.connections);
      setLogs(data.logs);
      setRateLimit(data.rateLimit);
      setQueue(data.queue);
      setEngine(data.engine);
      setPlaygroundHistory(data.playgroundHistory);
      setCommands(data.commands);
      setNeedsAuth(false);
    } catch (err) {
      if (err instanceof Error && err.message === 'UNAUTHORIZED') {
        setNeedsAuth(true);
      } else {
        setLoadError(err instanceof Error ? err.message : 'Unable to reach RelayBridge server');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  // Real-time Server-Sent Events subscription for live queue & delivery log updates
  useEffect(() => {
    if (needsAuth || loading) return;
    const token = getAuthToken();
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.queue) setQueue(msg.queue);
        if (msg.snapshot) setQueue(msg.snapshot);
        if (msg.engine) setEngine(msg.engine);
        if (msg.type === 'log' && msg.log) {
          setLogs((prev) => [msg.log as DeliveryLog, ...prev].slice(0, 250));
          // Refresh connection stats cleanly when deliveries complete
          void api.bootstrap().then((d) => {
            setConnections(d.connections);
            setChannels(d.channels);
          }).catch(() => {});
        }
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      es.close();
    };
  }, [needsAuth, loading]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await api.login(passcodeInput);
      setAuthToken(res.token);
      setPasscodeInput('');
      await loadWorkspace();
    } catch {
      setAuthError('Incorrect dashboard passcode.');
    }
  };

  const triggerNewConnection = (sourceId?: string) => {
    setPrefillSourceId(sourceId ?? null);
    setSection('connections');
    setOpenCreateSignal((n) => n + 1);
  };

  if (needsAuth) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 space-y-4"
        >
          <div className="flex items-center gap-2.5 text-slate-900">
            <Lock className="h-5 w-5 text-sky-600" />
            <h1 className="text-lg font-semibold">RelayBridge Sign In</h1>
          </div>
          <p className="text-xs text-slate-500">
            Enter your configured server dashboard passcode to manage Telegram forwarding routes.
          </p>
          <input
            type="password"
            value={passcodeInput}
            onChange={(e) => setPasscodeInput(e.target.value)}
            placeholder="Dashboard passcode"
            autoFocus
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
          />
          {authError && <p className="text-xs text-red-600">{authError}</p>}
          <button
            type="submit"
            className="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 cursor-pointer"
          >
            Unlock Control Center
          </button>
        </form>
      </div>
    );
  }

  const currentNavLabel = NAV_ITEMS.find((i) => i.id === section)?.label ?? 'Connections';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Mobile Sidebar Backdrop */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Left Workspace Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            RelayBridge
          </span>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 lg:hidden cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSection(item.id);
                  setMobileNavOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-sky-50 text-sky-800'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-sky-600' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Quiet Runtime Summary in Sidebar Footer */}
        <div className="border-t border-slate-200 px-5 py-4 text-xs text-slate-500 space-y-1.5">
          <div className="flex items-center justify-between">
            <span>Bot API</span>
            <span className={engine.botApiRunning ? 'font-medium text-emerald-700' : 'text-slate-500'}>
              {engine.botApiRunning ? 'Live' : 'Preview'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Userbot MTProto</span>
            <span className={engine.userbotRunning ? 'font-medium text-emerald-700' : 'text-slate-500'}>
              {engine.userbotRunning ? 'Live' : 'Preview'}
            </span>
          </div>
          <div className="flex items-center justify-between font-mono tabular-nums pt-1 border-t border-slate-100">
            <span className="font-sans">Queue Pending</span>
            <span className="text-slate-800">{queue.pendingCount}</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Contextual Top Header Bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-6 border-b border-slate-200 bg-white/95 backdrop-blur-xs px-5 lg:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden cursor-pointer"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 truncate">
              <span className="font-medium text-slate-900 whitespace-nowrap">RelayBridge</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{currentNavLabel}</span>
            </div>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => triggerNewConnection()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              New Connection
            </button>
          </div>
        </header>

        {/* Workspace Viewport */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6 lg:px-8 lg:py-8">
          {loading ? (
            <div className="space-y-4">
              <div className="h-8 w-56 rounded-lg bg-slate-200/70 animate-pulse" />
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-24 rounded-xl border border-slate-200 bg-white p-4" />
                ))}
              </div>
              <div className="h-64 rounded-xl border border-slate-200 bg-white" />
            </div>
          ) : loadError ? (
            <div className="rounded-xl border border-red-200 bg-white p-6 space-y-3">
              <h2 className="text-base font-semibold text-red-700">Unable to load workspace</h2>
              <p className="text-sm text-slate-600">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadWorkspace()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 cursor-pointer"
              >
                Retry Connection
              </button>
            </div>
          ) : (
            <>
              {section === 'connections' && (
                <ConnectionsView
                  connections={connections}
                  channels={channels}
                  initialSourceIdForModal={prefillSourceId}
                  openCreateModalSignal={openCreateSignal}
                  onClearInitialSource={() => setPrefillSourceId(null)}
                  onCreateConnection={async (payload) => {
                    const res = await api.createConnection(payload);
                    setConnections(res.connections);
                  }}
                  onUpdateConnection={async (id, patch) => {
                    const res = await api.updateConnection(id, patch);
                    setConnections(res.connections);
                  }}
                  onDeleteConnection={async (id) => {
                    const res = await api.deleteConnection(id);
                    setConnections(res.connections);
                  }}
                  onTestDispatch={async (payload) => {
                    const res = await api.dispatchTestPost(payload);
                    setQueue(res.queue);
                    setConnections(res.connections);
                    setLogs(res.logs);
                  }}
                  onGoToChannels={() => setSection('channels')}
                  onGoToPlayground={() => setSection('playground')}
                />
              )}

              {section === 'channels' && (
                <ChannelsView
                  channels={channels}
                  connections={connections}
                  onAddChannel={async (payload) => {
                    const res = await api.createChannel(payload);
                    setChannels(res.channels);
                  }}
                  onUpdateRole={async (id, role) => {
                    const res = await api.updateChannel(id, { role });
                    setChannels(res.channels);
                  }}
                  onDeleteChannel={async (id) => {
                    const res = await api.deleteChannel(id);
                    setChannels(res.channels);
                    setConnections(res.connections);
                  }}
                  onConnectSource={(sourceId) => triggerNewConnection(sourceId)}
                />
              )}

              {section === 'playground' && (
                <BotPlaygroundView
                  history={playgroundHistory}
                  commands={commands}
                  channels={channels}
                  botUsername={engine.botUsername}
                  onSendMessage={async (text) => {
                    const res = await api.sendBotMessage(text);
                    setPlaygroundHistory(res.playgroundHistory);
                    setChannels(res.channels);
                    setConnections(res.connections);
                  }}
                  onForwardPost={async (payload) => {
                    const res = await api.forwardPostToBot(payload);
                    setPlaygroundHistory(res.playgroundHistory);
                    setChannels(res.channels);
                    setConnections(res.connections);
                  }}
                  onClickCallback={async (callbackData) => {
                    const res = await api.clickBotCallback(callbackData);
                    setPlaygroundHistory(res.playgroundHistory);
                    setChannels(res.channels);
                    setConnections(res.connections);
                  }}
                  onResetHistory={async () => {
                    const res = await api.resetBotHistory();
                    setPlaygroundHistory(res.playgroundHistory);
                  }}
                  onDispatchTestPost={async (payload) => {
                    const res = await api.dispatchTestPost(payload);
                    setQueue(res.queue);
                    setConnections(res.connections);
                    setLogs(res.logs);
                    return {
                      matchedConnections: res.matchedConnections,
                      queuedTasks: res.queuedTasks,
                      filteredOut: res.filteredOut,
                    };
                  }}
                />
              )}

              {section === 'queue' && (
                <QueueMonitorView
                  queue={queue}
                  rateLimit={rateLimit}
                  logs={logs}
                  channels={channels}
                  onUpdateRateLimit={async (patch) => {
                    const res = await api.updateRateLimit(patch);
                    setRateLimit(res.rateLimit);
                    setQueue(res.queue);
                  }}
                  onSimulateFloodWait={async (channelId, seconds) => {
                    const res = await api.simulateFloodWait(channelId, seconds);
                    setQueue(res.queue);
                  }}
                  onClearLogs={async () => {
                    const res = await api.clearLogs();
                    setLogs(res.logs);
                  }}
                />
              )}

              {section === 'deployment' && <DeploymentView engine={engine} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
