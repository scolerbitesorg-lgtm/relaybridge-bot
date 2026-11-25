import crypto from 'node:crypto';
import type { ConnectionFilterSettings, IncomingMessagePayload } from './types.ts';

export interface FilterEvaluationResult {
  allowed: boolean;
  reason?: string;
  transformedCaption: string;
  mode: 'copy' | 'forward';
}

// Per-connection deduplication LRU cache (stores hashes of recently forwarded items)
const dedupeCache = new Map<string, Set<string>>();
const MAX_DEDUPE_PER_CONN = 500;

function getContentFingerprint(payload: IncomingMessagePayload): string {
  if (payload.fileUniqueId) {
    return `file:${payload.fileUniqueId}`;
  }
  const basis = [
    payload.mediaType,
    payload.fileName ?? '',
    String(payload.fileSizeMb ?? ''),
    (payload.caption ?? payload.text ?? '').trim().toLowerCase(),
  ].join('|');
  return `hash:${crypto.createHash('sha1').update(basis).digest('hex')}`;
}

function recordFingerprint(connectionId: string, fingerprint: string): boolean {
  let set = dedupeCache.get(connectionId);
  if (!set) {
    set = new Set<string>();
    dedupeCache.set(connectionId, set);
  }
  if (set.has(fingerprint)) {
    return true; // Duplicate!
  }
  set.add(fingerprint);
  if (set.size > MAX_DEDUPE_PER_CONN) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  return false;
}

export function evaluateFilters(
  connectionId: string,
  filters: ConnectionFilterSettings,
  payload: IncomingMessagePayload,
): FilterEvaluationResult {
  // 1. Media type allow check
  if (!filters.allowedMedia[payload.mediaType]) {
    return {
      allowed: false,
      reason: `Media type "${payload.mediaType}" is disabled in connection settings`,
      transformedCaption: '',
      mode: filters.forwardMode,
    };
  }

  const rawText = (payload.caption ?? payload.text ?? '').trim();

  // 2. "Only with caption" enforcement (e.g., Only Videos with Caption)
  if (filters.onlyWithCaption && payload.mediaType !== 'text' && rawText.length === 0) {
    return {
      allowed: false,
      reason: 'Skipped: connection requires caption on media posts',
      transformedCaption: '',
      mode: filters.forwardMode,
    };
  }

  // 3. File size bounds (when fileSizeMb is known)
  if (typeof payload.fileSizeMb === 'number' && payload.fileSizeMb > 0) {
    if (filters.minFileSizeMb > 0 && payload.fileSizeMb < filters.minFileSizeMb) {
      return {
        allowed: false,
        reason: `Skipped: file size ${payload.fileSizeMb.toFixed(1)} MB < min ${filters.minFileSizeMb} MB`,
        transformedCaption: '',
        mode: filters.forwardMode,
      };
    }
    if (filters.maxFileSizeMb > 0 && payload.fileSizeMb > filters.maxFileSizeMb) {
      return {
        allowed: false,
        reason: `Skipped: file size ${payload.fileSizeMb.toFixed(1)} MB > max ${filters.maxFileSizeMb} MB`,
        transformedCaption: '',
        mode: filters.forwardMode,
      };
    }
  }

  // 4. Keyword Whitelist / Blacklist
  const haystack = `${rawText} ${payload.fileName ?? ''}`.toLowerCase();
  if (filters.keywordWhitelist.length > 0) {
    const matched = filters.keywordWhitelist.some(
      (kw) => kw.trim().length > 0 && haystack.includes(kw.trim().toLowerCase()),
    );
    if (!matched) {
      return {
        allowed: false,
        reason: 'Skipped: did not match any required whitelist keyword',
        transformedCaption: '',
        mode: filters.forwardMode,
      };
    }
  }

  if (filters.keywordBlacklist.length > 0) {
    const blocked = filters.keywordBlacklist.find(
      (kw) => kw.trim().length > 0 && haystack.includes(kw.trim().toLowerCase()),
    );
    if (blocked) {
      return {
        allowed: false,
        reason: `Skipped: matched blocked keyword "${blocked}"`,
        transformedCaption: '',
        mode: filters.forwardMode,
      };
    }
  }

  // 5. Deduplication check
  if (filters.deduplicate) {
    const fp = getContentFingerprint(payload);
    if (recordFingerprint(connectionId, fp)) {
      return {
        allowed: false,
        reason: 'Skipped: duplicate file or message already forwarded',
        transformedCaption: '',
        mode: filters.forwardMode,
      };
    }
  }

  // 6. Transform caption/text cleanly
  let outText = filters.stripCaption ? '' : rawText;

  if (outText.length > 0) {
    if (filters.stripLinks) {
      outText = outText
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/(?:^|\s)t\.me\/\S+/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    if (filters.stripUsernames) {
      outText = outText.replace(/@[a-zA-Z0-9_]{3,}/g, '').replace(/\s{2,}/g, ' ').trim();
    }
    for (const rule of filters.findReplace) {
      if (rule.find && rule.find.length > 0) {
        outText = outText.split(rule.find).join(rule.replace ?? '');
      }
    }
  }

  const parts: string[] = [];
  if (filters.captionPrefix.trim()) parts.push(filters.captionPrefix.trim());
  if (outText) parts.push(outText);
  if (filters.captionSuffix.trim()) parts.push(filters.captionSuffix.trim());

  const transformedCaption = parts.join('\n\n').slice(0, 1024);

  return {
    allowed: true,
    transformedCaption,
    mode: filters.forwardMode,
  };
}
