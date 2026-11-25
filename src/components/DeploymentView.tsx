import React, { useEffect, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { api } from '../api';
import type { EngineStatus, ExportBundle } from '../types';

interface DeploymentViewProps {
  engine: EngineStatus;
}

type FileTab = 'pythonBot' | 'configJson' | 'requirementsTxt' | 'envTemplate' | 'readmeMd';

const FILE_META: Record<FileTab, { label: string; filename: string }> = {
  pythonBot: { label: 'bot.py (Telethon + Bot API)', filename: 'bot.py' },
  configJson: { label: 'config.json (Live Routes)', filename: 'config.json' },
  requirementsTxt: { label: 'requirements.txt', filename: 'requirements.txt' },
  envTemplate: { label: '.env.example', filename: '.env.example' },
  readmeMd: { label: 'README.md', filename: 'README.md' },
};

export const DeploymentView: React.FC<DeploymentViewProps> = ({ engine }) => {
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [activeTab, setActiveTab] = useState<FileTab>('pythonBot');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api
      .getExportBundle()
      .then((res) => {
        if (mounted) setBundle(res);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const currentContent = bundle ? bundle[activeTab] : '';

  const handleCopy = async () => {
    if (!currentContent) return;
    await navigator.clipboard.writeText(currentContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownload = (tab: FileTab) => {
    if (!bundle) return;
    const blob = new Blob([bundle[tab]], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE_META[tab].filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const readinessItems = [
    {
      name: 'Telegram Bot API (grammY)',
      envVars: 'TELEGRAM_BOT_TOKEN',
      configured: engine.botApiConfigured,
      running: engine.botApiRunning,
      detail: engine.botApiRunning
        ? `Connected live as @${engine.botUsername ?? 'bot'}`
        : engine.botApiConfigured
          ? 'Configured in server secrets (reconnecting...)'
          : 'Add TELEGRAM_BOT_TOKEN in Settings -> Secrets to go live on Telegram',
    },
    {
      name: 'MTProto Userbot (GramJS)',
      envVars: 'TELEGRAM_API_ID · TELEGRAM_API_HASH · TELEGRAM_USERBOT_SESSION',
      configured: engine.userbotConfigured,
      running: engine.userbotRunning,
      detail: engine.userbotRunning
        ? `Connected live as ${engine.userbotAccount ?? 'Userbot'} (open channels + 2GB files ready)`
        : engine.userbotConfigured
          ? 'Configured in server secrets (initializing session...)'
          : 'Add Userbot secrets in Settings -> Secrets to read open channels without admin rights',
    },
    {
      name: 'Operator Access Control',
      envVars: 'TELEGRAM_ADMIN_IDS · DASHBOARD_PASSCODE',
      configured: engine.adminRestrictionEnabled || engine.passcodeProtected,
      running: engine.adminRestrictionEnabled || engine.passcodeProtected,
      detail:
        engine.adminRestrictionEnabled || engine.passcodeProtected
          ? 'Server-side allowlist / passcode active'
          : 'Optional: restrict Telegram bot commands & web dashboard via Secrets',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Live Engine Readiness &amp; Deployment Export
        </h1>
        <p className="mt-1 text-sm text-slate-600 max-w-2xl">
          Run the built-in Node.js Bot + Userbot directly on this server using environment Secrets, or download the standalone Python Telethon + Bot API package synced with all your current connections and filters.
        </p>
      </div>

      {/* Server-Side Secret Readiness Table (No API Key Inputs in UI) */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-3.5 bg-slate-50/70">
          <h2 className="text-sm font-semibold text-slate-900">
            Built-in Server Environment Status
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            All Telegram tokens and Userbot sessions stay strictly server-side in environment variables (never exposed to the browser).
          </p>
        </div>

        <div className="divide-y divide-slate-100">
          {readinessItems.map((item) => (
            <div
              key={item.name}
              className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-sm font-semibold text-slate-900">{item.name}</div>
                <div className="mt-0.5 font-mono text-xs text-slate-500">{item.envVars}</div>
                <div className="mt-1 text-xs text-slate-600">{item.detail}</div>
              </div>
              <div className="shrink-0 text-xs font-medium">
                {item.running ? (
                  <span className="text-emerald-700">Live &amp; Active</span>
                ) : item.configured ? (
                  <span className="text-amber-700">Configured</span>
                ) : (
                  <span className="text-slate-500">Not Configured (Preview Mode)</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {engine.lastError && (
          <div className="border-t border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
            Last runtime notice: {engine.lastError}
          </div>
        )}
      </div>

      {/* Standalone Bot + Userbot Export Explorer */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Standalone VPS / Cloud Deployment Package
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Exported live with your current saved channels, connections, filter rules, and rate-limit settings.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!currentContent}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy File'}
            </button>
            <button
              type="button"
              onClick={() => handleDownload(activeTab)}
              disabled={!currentContent}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 cursor-pointer whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              Download {FILE_META[activeTab].filename}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-4 py-2 overflow-x-auto">
          {(Object.keys(FILE_META) as FileTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {FILE_META[tab].label}
            </button>
          ))}
        </div>

        <div className="bg-slate-950 p-5 overflow-x-auto max-h-[460px]">
          {loading ? (
            <div className="text-xs font-mono text-slate-400">Generating synced bundle...</div>
          ) : (
            <pre className="font-mono text-xs leading-relaxed text-slate-200 whitespace-pre">
              {currentContent}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
