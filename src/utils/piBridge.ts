import { WasteReport, PiStatus, SavedLogBook, TelegramBotStatus, TelegramChatMessage } from '../types';
import { BRGY_41_HALL_COORDS, evaluateJurisdiction } from './jurisdiction';
import { formatTicketNumber, canonicalTicketKey, isValidPhotoSrc } from './imageCompressor';
import { AUTO_PURGE_TTL_DAYS, computeUnifiedPurgeInfo } from './purgeConfig';
import {
  HARDCODED_PI_SERVER_URL,
  LOCK_TO_HARDCODED_PI_SERVER,
  isUrlAllowedUnderLock,
  resolveLockedCloudServerState,
} from './cloudServerConfig';
import {
  buildTelegramReplyMarkupForChat,
  buildNewConcernInlineKeyboard,
  buildNewConcernMessage1Html,
  buildNewConcernPhotoCaptionHtml,
  buildActiveUnresolvedConcernsMessage2Html,
  buildResolvedConcernMessage1Html,
  generateBotChatReply,
  getTelegramPhTime,
  htmlToPlainTelegramText,
} from './telegramBotEngine';

const BARE_TUNNEL_ROOTS = new Set([
  'ngrok.dev',
  'www.ngrok.dev',
  'ngrok.com',
  'www.ngrok.com',
  'ngrok.app',
  'ngrok-free.app',
  'ngrok-free.dev',
  'ngrok.io',
  'trycloudflare.com',
  'cloudflare.com',
  'www.cloudflare.com',
  'loca.lt',
  'ts.net',
  'pages.dev',
  'workers.dev',
]);

export function isLocalLanUrl(urlOrHost: string): boolean {
  try {
    const cleaned = urlOrHost.trim();
    if (!cleaned) return false;
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`;
    const parsed = new URL(withProto);
    const h = parsed.hostname.toLowerCase();
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h.endsWith('.local') ||
      h.startsWith('192.168.') ||
      h.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
    );
  } catch {
    return false;
  }
}

function isPublicTunnelHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h.endsWith('.ngrok-free.dev') ||
    h.endsWith('.ngrok-free.app') ||
    h.endsWith('.ngrok.dev') ||
    h.endsWith('.ngrok.app') ||
    h.endsWith('.ngrok.io') ||
    h.endsWith('.trycloudflare.com') ||
    h.endsWith('.ts.net') ||
    h.endsWith('.loca.lt')
  );
}

export function isBareTunnelRootDomain(rawInput: string): boolean {
  try {
    const cleaned = rawInput.trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
    if (!cleaned) return false;
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    const parsed = new URL(withProto);
    return BARE_TUNNEL_ROOTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isValidPiUrlSyntax(cleanUrl: string): boolean {
  if (!cleanUrl || isBareTunnelRootDomain(cleanUrl)) return false;
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (!h) return false;
    if (typeof window !== 'undefined' && window.location?.origin) {
      if (parsed.origin.toLowerCase() === window.location.origin.toLowerCase()) {
        return false;
      }
    }
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':');
    const isLocal = h === 'localhost' || h.endsWith('.local');
    const hasValidDomain =
      h.includes('.') && /\.[a-z]{2,}$/i.test(h) && !h.startsWith('.') && !h.endsWith('.');
    return isIp || isLocal || hasValidDomain;
  } catch {
    return false;
  }
}

export function isValidPiHealthPayload(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (parsed.online === false || parsed.ok === false || parsed.healthy === false) return false;
  const statusStr = String(parsed.status ?? parsed.state ?? '').trim().toLowerCase();
  if (['offline', 'error', 'down', 'dead', 'disconnected', 'fail', 'failed'].includes(statusStr)) {
    return false;
  }
  if (parsed.error && !statusStr && parsed.online !== true && parsed.ok !== true) {
    return false;
  }
  const positiveStatuses = [
    'online',
    'active',
    'ok',
    'healthy',
    'running',
    'up',
    'ready',
    'connected',
    'live',
    'success',
  ];
  if (positiveStatuses.includes(statusStr)) return true;
  if (
    parsed.online === true ||
    parsed.ok === true ||
    parsed.healthy === true ||
    parsed.active === true
  ) {
    return true;
  }
  if (
    parsed.storage_folder ||
    parsed.hardware ||
    parsed.system ||
    parsed.disk_total ||
    parsed.cpu_temp ||
    typeof parsed.reports_count === 'number'
  ) {
    return true;
  }
  return false;
}

export function detectPiConnectionMethod(url: string): string {
  const lower = (url || '').toLowerCase();
  if (!lower) return 'None';
  if (lower.includes('ngrok')) return 'ngrok Domain Tunnel';
  if (lower.includes('trycloudflare') || lower.includes('cloudflare')) return 'Cloudflare Tunnel';
  if (lower.includes('.ts.net') || lower.includes('tailscale')) return 'Tailscale Funnel';
  if (isLocalLanUrl(lower)) return 'Local Wi-Fi / LAN';
  return 'HTTPS Cloud Domain';
}

export function normalizeClientPiUrl(raw: string): string {
  if (!raw) return '';
  let u = raw.trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
  if (!u || (/\s/.test(u) && !/https?:\/\//i.test(u))) return '';

  // Extract clean URL if user copied an entire terminal line (e.g. "Forwarding https://pi.tugon-brgy40-41.org -> http://localhost:8000")
  const embeddedUrlMatch = u.match(
    /https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s|"'<>]*)?/i
  );
  if (embeddedUrlMatch && (u.includes(' ') || u.includes('->') || u.includes('|'))) {
    const allMatches = u.match(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?/gi) || [];
    const publicTunnel = allMatches.find((m) => !isLocalLanUrl(m));
    u = publicTunnel || embeddedUrlMatch[0];
  }

  if (!/^https?:\/\//i.test(u)) {
    const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|.*\.local)/i.test(u);
    if (isLocal) {
      const hasPort = /:\d+(\/|$)/.test(u);
      u = `http://${hasPort ? u : `${u.replace(/\/+$/, '')}:8000`}`;
    } else {
      u = `https://${u}`;
    }
  } else if (/^http:\/\//i.test(u) && !isLocalLanUrl(u)) {
    const isHttpsPage =
      typeof window !== 'undefined' && window.location?.protocol === 'https:';
    const isKnownHttpsTunnel = /\.(ngrok\.dev|ngrok-free\.(app|dev)|ngrok\.(app|io)|trycloudflare\.com|ts\.net|pages\.dev|workers\.dev)(\/|:|$)/i.test(
      u
    );
    if (isHttpsPage || isKnownHttpsTunnel) {
      u = u.replace(/^http:\/\//i, 'https://');
    }
  }

  try {
    const parsed = new URL(u);
    if (isPublicTunnelHostname(parsed.hostname) && (parsed.port === '3000' || parsed.port === '8000')) {
      parsed.port = '';
      u = parsed.toString();
    }
  } catch {
    return '';
  }

  return u
    .replace(/\/api\/(health|storage|reports|logbooks|config|pi-status)\/?$/i, '')
    .replace(/\/test\.txt$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Builds CORS-safe headers for direct browser-to-Pi requests.
 * IMPORTANT: Only sends headers listed in server.py's Access-Control-Allow-Headers
 * so preflight OPTIONS requests never fail on older or newer server.py deployments.
 */
export function getPiHeaders(
  targetUrl = '',
  withJsonContentType = false
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const lower = targetUrl.toLowerCase();
  if (lower.includes('ngrok')) {
    headers['ngrok-skip-browser-warning'] = 'true';
  } else if (lower.includes('loca.lt')) {
    headers['Bypass-Tunnel-Reminder'] = 'true';
  }
  if (withJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

export const CLIENT_PI_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'ngrok-skip-browser-warning': 'true',
};

export function getCloudServerLockInfo(): {
  locked: boolean;
  lockedUrl: string;
  source: string;
} {
  try {
    if (LOCK_TO_HARDCODED_PI_SERVER && HARDCODED_PI_SERVER_URL) {
      return {
        locked: true,
        lockedUrl: normalizeClientPiUrl(HARDCODED_PI_SERVER_URL),
        source: 'hardcoded',
      };
    }
    const lockedFlag = localStorage.getItem('pulse_pi_locked') === 'true';
    const lockedUrl = normalizeClientPiUrl(localStorage.getItem('pulse_pi_locked_url') || '');
    const source = localStorage.getItem('pulse_pi_lock_source') || 'unlocked';
    if (lockedFlag && lockedUrl) {
      return { locked: true, lockedUrl, source };
    }
  } catch {}
  return { locked: false, lockedUrl: '', source: 'unlocked' };
}

export function setClientCloudServerLock(locked: boolean, lockedUrl: string, source = 'server_lock'): void {
  try {
    const clean = normalizeClientPiUrl(lockedUrl);
    if (locked && clean) {
      localStorage.setItem('pulse_pi_locked', 'true');
      localStorage.setItem('pulse_pi_locked_url', clean);
      localStorage.setItem('pulse_pi_lock_source', source);
      localStorage.setItem('pulse_pi_endpoint', clean);
    } else {
      localStorage.removeItem('pulse_pi_locked');
      localStorage.removeItem('pulse_pi_locked_url');
      localStorage.removeItem('pulse_pi_lock_source');
    }
  } catch {}
}

export function getStoredPiEndpoint(): string {
  try {
    const lockInfo = getCloudServerLockInfo();
    if (lockInfo.locked && lockInfo.lockedUrl) {
      return lockInfo.lockedUrl;
    }

    // 1. Check URL query string (?pi=https://... or ?server=https://...) for instant link binding when unlocked
    if (typeof window !== 'undefined' && window.location?.search) {
      const sp = new URLSearchParams(window.location.search);
      const queryPi = sp.get('pi') || sp.get('server') || sp.get('pi_url');
      if (queryPi) {
        const normalizedQuery = normalizeClientPiUrl(queryPi);
        if (normalizedQuery && !isBareTunnelRootDomain(normalizedQuery)) {
          localStorage.setItem('pulse_pi_endpoint', normalizedQuery);
          return normalizedQuery;
        }
      }
    }

    // 2. Check browser localStorage
    const raw = localStorage.getItem('pulse_pi_endpoint') || '';
    const clean = normalizeClientPiUrl(raw);
    if (clean && !isBareTunnelRootDomain(clean)) {
      return clean;
    }

    // 3. Check build-time Vite environment variable
    const envUrl = (import.meta as any)?.env?.VITE_PI_SERVER_URL || '';
    const cleanEnv = normalizeClientPiUrl(envUrl);
    if (cleanEnv && !isBareTunnelRootDomain(cleanEnv)) {
      return cleanEnv;
    }

    return '';
  } catch {
    return '';
  }
}

export function setStoredPiEndpoint(url: string): void {
  try {
    const lockInfo = getCloudServerLockInfo();
    if (lockInfo.locked && lockInfo.lockedUrl) {
      localStorage.setItem('pulse_pi_endpoint', lockInfo.lockedUrl);
      return;
    }
    const clean = normalizeClientPiUrl(url);
    if (clean && !isBareTunnelRootDomain(clean)) {
      localStorage.setItem('pulse_pi_endpoint', clean);
    } else if (!url.trim()) {
      localStorage.removeItem('pulse_pi_endpoint');
    }
  } catch {}
}

export function buildShareablePortalUrl(piUrl?: string): string {
  const cleanPi = normalizeClientPiUrl(piUrl || getStoredPiEndpoint());
  if (typeof window === 'undefined') return cleanPi;
  const base = `${window.location.origin}${window.location.pathname}`;
  if (!cleanPi) return base;
  return `${base}?pi=${encodeURIComponent(cleanPi)}`;
}

async function safePortalApiFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 7000
): Promise<{
  ok: boolean;
  status: number;
  data: any;
  headers: Headers | null;
  isStaticFallback: boolean;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const activePi = getStoredPiEndpoint();
    const mergedHeaders = new Headers(init.headers || {});
    if (!mergedHeaders.has('Accept')) {
      mergedHeaders.set('Accept', 'application/json');
    }
    if (activePi && !mergedHeaders.has('X-Pi-Endpoint')) {
      mergedHeaders.set('X-Pi-Endpoint', activePi);
    }

    const res = await fetch(path, {
      cache: init.cache || 'no-store',
      ...init,
      headers: mergedHeaders,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    // On static hosts (Cloudflare Workers Static Assets, GitHub Pages), /api/* returns HTML index.html or 404/405
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: res.status,
        data: null,
        headers: res.headers,
        isStaticFallback: true,
      };
    }

    const data = await res.json().catch(() => null);
    if (data && (data.edgeUnhandled || data.edgeNeedsDirectClient)) {
      return {
        ok: false,
        status: res.status,
        data,
        headers: res.headers,
        isStaticFallback: true,
      };
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
      headers: res.headers,
      isStaticFallback: false,
    };
  } catch {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      data: null,
      headers: null,
      isStaticFallback: true,
    };
  }
}

export async function hydratePiEndpointOnBoot(): Promise<string> {
  const existing = getStoredPiEndpoint();

  // Clean ?pi= from address bar after capturing it so URL stays tidy
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const urlObj = new URL(window.location.href);
      if (urlObj.searchParams.has('pi') || urlObj.searchParams.has('server')) {
        urlObj.searchParams.delete('pi');
        urlObj.searchParams.delete('server');
        window.history.replaceState({}, '', urlObj.pathname + urlObj.search + urlObj.hash);
      }
    }
  } catch {}

  let staticUrl = '';
  let staticLocked = false;
  try {
    const staticRes = await fetch('/pi-config.json', { cache: 'no-store' });
    const ct = (staticRes.headers.get('content-type') || '').toLowerCase();
    if (staticRes.ok && ct.includes('application/json')) {
      const staticJson = await staticRes.json();
      const candidate = normalizeClientPiUrl(staticJson?.piServerUrl || '');
      if (candidate && !isBareTunnelRootDomain(candidate)) {
        staticUrl = candidate;
        staticLocked = Boolean(staticJson?.locked);
      }
    }
  } catch {}

  const apiCfg = await safePortalApiFetch('/api/config', {}, 3500);
  const envUrl = normalizeClientPiUrl((import.meta as any)?.env?.VITE_PI_SERVER_URL || '');
  const envLocked = (import.meta as any)?.env?.VITE_PI_SERVER_LOCKED === 'true';

  const resolvedLock = resolveLockedCloudServerState({
    envUrl,
    envLocked,
    staticConfigUrl: staticUrl,
    staticConfigLocked: staticLocked,
    persistedUrl: normalizeClientPiUrl(apiCfg.data?.piServerUrl || ''),
    persistedLocked: Boolean(apiCfg.data?.piServerLocked),
  });

  if (resolvedLock.locked && resolvedLock.lockedUrl) {
    setClientCloudServerLock(true, resolvedLock.lockedUrl, resolvedLock.source);
    return resolvedLock.lockedUrl;
  }

  if (apiCfg.ok && apiCfg.data?.piServerUrl) {
    const remotePi = normalizeClientPiUrl(apiCfg.data.piServerUrl);
    if (remotePi && !existing) {
      setStoredPiEndpoint(remotePi);
      return remotePi;
    }
  }

  if (staticUrl && !existing) {
    setStoredPiEndpoint(staticUrl);
    return staticUrl;
  }

  return existing;
}

export async function probeDirectPiFromBrowser(
  rawUrl: string,
  timeoutMs = 5500
): Promise<{
  online: boolean;
  latencyMs: number;
  healthJson: any;
  connectionMethod: string;
  resolvedUrl?: string;
  errorDetail?: string;
}> {
  const cleanUrl = normalizeClientPiUrl(rawUrl);
  if (!cleanUrl || !isValidPiUrlSyntax(cleanUrl)) {
    return {
      online: false,
      latencyMs: 0,
      healthJson: null,
      connectionMethod: 'None',
    };
  }

  const hadExplicitPort = /:\d+(\/|$)/.test(rawUrl.trim());
  const candidates = [cleanUrl];
  if (isLocalLanUrl(cleanUrl) && !hadExplicitPort && cleanUrl.endsWith(':8000')) {
    candidates.push(cleanUrl.replace(/:8000$/, ':3000'));
  }

  for (const candidateUrl of candidates) {
    const start = Date.now();
    const trySingleProbe = async (useSimpleNoHeaderRequest: boolean) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${candidateUrl}/api/health`, {
          signal: ctrl.signal,
          headers: useSimpleNoHeaderRequest ? undefined : getPiHeaders(candidateUrl),
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const text = await res.text();
        let healthJson: any = null;
        try {
          healthJson = JSON.parse(text);
        } catch {}
        if (isValidPiHealthPayload(healthJson)) {
          return {
            online: true,
            latencyMs: Math.max(1, Date.now() - start),
            healthJson,
            resolvedUrl: candidateUrl,
            connectionMethod: `${detectPiConnectionMethod(candidateUrl)} (Direct)`,
          };
        }
      } catch (err: any) {
        clearTimeout(timer);
        throw err;
      }
      return null;
    };

    try {
      const hit = await trySingleProbe(false);
      if (hit) return hit;
    } catch (err: any) {
      // Retry without custom headers (avoids OPTIONS preflight on servers that allow simple GET CORS)
      if (!candidateUrl.toLowerCase().includes('ngrok')) {
        try {
          const simpleHit = await trySingleProbe(true);
          if (simpleHit) return simpleHit;
        } catch {}
      }

      const isMixedContent =
        typeof window !== 'undefined' &&
        window.location?.protocol === 'https:' &&
        candidateUrl.startsWith('http://');
      if (isMixedContent && candidateUrl === candidates[candidates.length - 1]) {
        return {
          online: false,
          latencyMs: 0,
          healthJson: null,
          connectionMethod: detectPiConnectionMethod(candidateUrl),
          errorDetail:
            'Mixed Content blocked: HTTPS websites require an HTTPS Cloud Server URL rather than an unencrypted http://192.168.x.x LAN address.',
        };
      }
      if (candidateUrl === candidates[candidates.length - 1]) {
        return {
          online: false,
          latencyMs: 0,
          healthJson: null,
          connectionMethod: detectPiConnectionMethod(candidateUrl),
          errorDetail: err?.message || 'Unreachable',
        };
      }
    }
  }

  return {
    online: false,
    latencyMs: 0,
    healthJson: null,
    connectionMethod: detectPiConnectionMethod(cleanUrl),
  };
}

function parseClientUpdatedTs(r: WasteReport): number {
  const raw = r.updatedAt || r.resolvedAt || r.cancelledAt || r.dispatchedAt || r.createdAt;
  if (!raw) return 0;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Non-destructive merge of two WasteReport arrays (prefers newest updatedAt / portalRevision, falling back to status/proofs).
 */
export function mergeWasteReportArrays(
  listA: WasteReport[],
  listB: WasteReport[]
): WasteReport[] {
  const byId = new Map<string, WasteReport>();
  const ticketToKey = new Map<string, string>();
  const rank = (r: WasteReport) => {
    if (r.status === 'RESOLVED') return 4;
    if (r.status === 'CANCELLED') return 3;
    if (r.status === 'DISPATCHED') return 2;
    return 1;
  };
  const compareRecords = (a: WasteReport, b: WasteReport): number => {
    const tsA = parseClientUpdatedTs(a);
    const tsB = parseClientUpdatedTs(b);
    if (tsA !== tsB) return tsA - tsB;
    const revA = Number(a.portalRevision || 0);
    const revB = Number(b.portalRevision || 0);
    if (revA !== revB) return revA - revB;
    const scoreA = rank(a) * 10 + (a.proofPhotos?.filter(isValidPhotoSrc).length || 0);
    const scoreB = rank(b) * 10 + (b.proofPhotos?.filter(isValidPhotoSrc).length || 0);
    return scoreA - scoreB;
  };

  const pickBestPhotos = (primary?: string[], secondary?: string[]): string[] => {
    const validPrimary = Array.isArray(primary) ? primary.filter(isValidPhotoSrc) : [];
    const validSecondary = Array.isArray(secondary) ? secondary.filter(isValidPhotoSrc) : [];
    if (validPrimary.length >= validSecondary.length && validPrimary.length > 0) return validPrimary;
    if (validSecondary.length > 0) return validSecondary;
    if (Array.isArray(primary) && primary.length > 0) return primary;
    if (Array.isArray(secondary) && secondary.length > 0) return secondary;
    return [];
  };

  for (const item of [...listA, ...listB]) {
    if (!item || (!item.id && !item.ticketNumber)) continue;
    const canonTk = item.ticketNumber ? canonicalTicketKey(item.ticketNumber) : '';
    const existingMappedKey = canonTk ? ticketToKey.get(canonTk) : undefined;
    const key = existingMappedKey || item.id || canonTk;
    if (!key) continue;
    if (canonTk && !ticketToKey.has(canonTk)) {
      ticketToKey.set(canonTk, key);
    }

    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, {
        ...item,
        ticketNumber: formatTicketNumber(item.ticketNumber),
      });
    } else {
      const winner = compareRecords(item, prev) >= 0 ? item : prev;
      const runnerUp = compareRecords(item, prev) >= 0 ? prev : item;
      const winnerExplicitEdit = Boolean(winner.updatedAt);
      const winnerIsRevertedPending = winnerExplicitEdit && winner.status === 'PENDING';
      byId.set(key, {
        ...runnerUp,
        ...winner,
        id: winner.id || runnerUp.id,
        ticketNumber: formatTicketNumber(winner.ticketNumber || runnerUp.ticketNumber),
        residentName: winnerExplicitEdit
          ? (winner.residentName ?? runnerUp.residentName ?? '')
          : (winner.residentName || runnerUp.residentName || ''),
        residentPhone: winnerExplicitEdit
          ? (winner.residentPhone ?? runnerUp.residentPhone)
          : (winner.residentPhone || runnerUp.residentPhone),
        streetAddress: winnerExplicitEdit
          ? (winner.streetAddress ?? runnerUp.streetAddress)
          : (winner.streetAddress || runnerUp.streetAddress),
        houseNumber: winnerExplicitEdit
          ? (winner.houseNumber ?? runnerUp.houseNumber)
          : (winner.houseNumber || runnerUp.houseNumber),
        landmark: winnerExplicitEdit
          ? (winner.landmark ?? runnerUp.landmark)
          : (winner.landmark || runnerUp.landmark),
        notes: winnerExplicitEdit
          ? (winner.notes ?? runnerUp.notes)
          : (winner.notes || runnerUp.notes),
        extraMessage: winnerExplicitEdit
          ? (winner.extraMessage ?? runnerUp.extraMessage)
          : (winner.extraMessage || runnerUp.extraMessage),
        dispatchedAt: winnerIsRevertedPending
          ? winner.dispatchedAt
          : (winner.dispatchedAt || runnerUp.dispatchedAt),
        dispatchedKagawad: winnerIsRevertedPending
          ? winner.dispatchedKagawad
          : (winner.dispatchedKagawad || runnerUp.dispatchedKagawad),
        resolvedAt: winnerIsRevertedPending
          ? winner.resolvedAt
          : (winner.resolvedAt || runnerUp.resolvedAt),
        resolvedBy: winnerIsRevertedPending
          ? winner.resolvedBy
          : (winner.resolvedBy || runnerUp.resolvedBy),
        resolutionNotes: winnerExplicitEdit
          ? (winner.resolutionNotes ?? runnerUp.resolutionNotes)
          : (winner.resolutionNotes || runnerUp.resolutionNotes),
        proofKagawadName: winnerIsRevertedPending
          ? winner.proofKagawadName
          : (winner.proofKagawadName || runnerUp.proofKagawadName),
        proofSubmittedAt: winnerIsRevertedPending
          ? winner.proofSubmittedAt
          : (winner.proofSubmittedAt || runnerUp.proofSubmittedAt),
        cancelledAt: winnerIsRevertedPending
          ? winner.cancelledAt
          : (winner.cancelledAt || runnerUp.cancelledAt),
        cancellationReason: winnerExplicitEdit
          ? (winner.cancellationReason ?? runnerUp.cancellationReason)
          : (winner.cancellationReason || runnerUp.cancellationReason),
        photos: pickBestPhotos(winner.photos, runnerUp.photos),
        proofPhotos: pickBestPhotos(winner.proofPhotos, runnerUp.proofPhotos),
      });
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

function enrichClientReport(r: WasteReport, lang: 'tl' | 'en'): WasteReport {
  const coords = r.coordinates || { lat: BRGY_41_HALL_COORDS[0], lng: BRGY_41_HALL_COORDS[1] };
  const juris = evaluateJurisdiction(coords.lat, coords.lng, r.barangay || r.purok);
  const assignedBarangay =
    r.barangay || (juris.isWithinBrgy40 ? 'Barangay 40' : 'Barangay 41');

  const purgeInfo = computeUnifiedPurgeInfo(r, lang);

  const localizedTypes = (Array.isArray(r.wasteTypes) ? r.wasteTypes : ['Household Trash']).map(
    (wt) => (lang === 'en' && wt === 'Nangangailangan ng assistance' ? 'Special Assistance Needed' : wt)
  );

  return {
    ...r,
    ticketNumber: formatTicketNumber(r.ticketNumber),
    barangay: assignedBarangay,
    purok: r.purok || `${assignedBarangay}, Cavite City`,
    coordinates: coords,
    isWithinJurisdiction: r.isWithinJurisdiction ?? juris.isWithinJurisdiction,
    isWithinBrgy41: r.isWithinBrgy41 ?? assignedBarangay.includes('41'),
    photos: Array.isArray(r.photos) ? r.photos : [],
    proofPhotos: Array.isArray(r.proofPhotos) ? r.proofPhotos : [],
    wasteTypes: localizedTypes,
    severityLevel: r.severityLevel || 'MODERATE',
    isElderly: Boolean(r.isElderly),
    extraMessage: r.extraMessage || '',
    storageUsedMb:
      r.storageUsedMb ||
      +(((r.photos?.length || 0) * 0.8) + ((r.proofPhotos?.length || 0) * 0.75)).toFixed(2),
    isPurgedFromFeed: purgeInfo.isPurgedFromFeed,
    purgeRemainingMs: purgeInfo.purgeRemainingMs,
    feedExpiresAt: purgeInfo.feedExpiresAt,
    purgeCountdownText: purgeInfo.purgeCountdownText,
    purgeTtlRule: purgeInfo.purgeTtlRule,
  };
}

/**
 * Direct Browser-to-LAN / Tunnel Bridge
 */
export async function probeAndBridgeLanPi(
  rawUrl: string,
  syncReports = false
): Promise<{ healthJson: any; latencyMs: number } | null> {
  const cleanUrl = normalizeClientPiUrl(rawUrl);
  if (!cleanUrl || isBareTunnelRootDomain(cleanUrl)) return null;

  const direct = await probeDirectPiFromBrowser(cleanUrl, 4500);
  if (!direct.online) return null;

  let piReports: any[] = [];
  if (syncReports) {
    try {
      const repRes = await fetch(`${cleanUrl}/api/reports`, {
        headers: getPiHeaders(cleanUrl),
      });
      if (repRes.ok) {
        const parsed = await repRes.json();
        if (Array.isArray(parsed)) piReports = parsed;
      }
    } catch {}
  }

  const bridgeRes = await safePortalApiFetch(
    '/api/pi/client-bridge',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: cleanUrl,
        piData: direct.healthJson,
        latencyMs: direct.latencyMs,
        piReports: syncReports ? piReports : undefined,
      }),
    },
    4000
  );

  if (syncReports && bridgeRes.ok && Array.isArray(bridgeRes.data?.reports)) {
    await fetch(`${cleanUrl}/api/reports/sync`, {
      method: 'POST',
      headers: getPiHeaders(cleanUrl, true),
      body: JSON.stringify(bridgeRes.data.reports),
    }).catch(() => null);
  }

  return { healthJson: direct.healthJson, latencyMs: direct.latencyMs };
}

/**
 * Unified Connect & Bind for RaspberryPiCenter.tsx:
 * Works across Node/Express, Cloudflare Pages Functions, and Cloudflare Workers.
 */
export async function pingAndConnectPiServer(
  rawUrl: string,
  lang: 'tl' | 'en'
): Promise<{
  success: boolean;
  online: boolean;
  normalizedUrl: string;
  latencyMs?: number;
  method?: string;
  message: string;
  error?: string;
}> {
  if (isBareTunnelRootDomain(rawUrl)) {
    const msg =
      lang === 'tl'
        ? 'Kulang ng sariling subdomain ang inilagay na link. Pakilagay ang buong Cloud Server URL (hal. https://pi.tugon-brgy40-41.org).'
        : 'The URL is incomplete. Please enter the full Cloud Server URL (e.g. https://pi.tugon-brgy40-41.org).';
    return {
      success: false,
      online: false,
      normalizedUrl: '',
      message: msg,
      error: msg,
    };
  }

  const cleanUrl = normalizeClientPiUrl(rawUrl);
  if (!cleanUrl || !isValidPiUrlSyntax(cleanUrl)) {
    const msg =
      lang === 'tl'
        ? 'Hindi valid ang inilagay na Cloud Server Link. Pakilagay ang tamang URL ng iyong Raspberry Pi server.'
        : 'Invalid Cloud Server Link format. Please enter a valid Raspberry Pi server URL.';
    return {
      success: false,
      online: false,
      normalizedUrl: '',
      message: msg,
      error: msg,
    };
  }

  const lockInfo = getCloudServerLockInfo();
  if (
    lockInfo.locked &&
    lockInfo.lockedUrl &&
    !isUrlAllowedUnderLock(cleanUrl, {
      locked: true,
      lockedUrl: lockInfo.lockedUrl,
      source: 'server_lock',
    })
  ) {
    const lockMsg =
      lang === 'tl'
        ? `Naka-LOCK ang Cloud Server link sa ${lockInfo.lockedUrl}. I-unlock muna gamit ang Admin password o configuration bago magpalit.`
        : `Cloud Server link is LOCKED to ${lockInfo.lockedUrl}. Unlock with Admin credentials or update configuration before changing.`;
    return {
      success: false,
      online: false,
      normalizedUrl: lockInfo.lockedUrl,
      message: lockMsg,
      error: lockMsg,
    };
  }

  // 1. Try server/edge /api/pi/ping first (Express Node, Cloudflare Pages Functions, or Cloudflare Workers Edge Bridge)
  const serverPing = await safePortalApiFetch(
    '/api/pi/ping',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanUrl, lang }),
    },
    7500
  );

  if (serverPing.ok && serverPing.data?.success && serverPing.data?.online) {
    const savedUrl = normalizeClientPiUrl(serverPing.data.normalizedUrl || cleanUrl);
    setStoredPiEndpoint(savedUrl);
    fetch(`${savedUrl}/api/config`, {
      method: 'POST',
      headers: getPiHeaders(savedUrl, true),
      body: JSON.stringify({ piServerUrl: savedUrl }),
    }).catch(() => null);

    return {
      success: true,
      online: true,
      normalizedUrl: savedUrl,
      latencyMs: serverPing.data.latencyMs,
      method: serverPing.data.method || detectPiConnectionMethod(savedUrl),
      message:
        lang === 'tl'
          ? `Konektado at Nai-save ang Cloud Server Link! (${serverPing.data.method || detectPiConnectionMethod(savedUrl)}, Bilis: ${serverPing.data.latencyMs}ms)`
          : `Cloud Server Link Connected & Saved! (${serverPing.data.method || detectPiConnectionMethod(savedUrl)}, Latency: ${serverPing.data.latencyMs}ms)`,
    };
  }

  // 2. Direct Browser-to-Cloud-Tunnel / LAN Probe (Works on Local Wi-Fi :3000/:8000 and CORS-enabled Pi tunnels)
  const direct = await probeDirectPiFromBrowser(rawUrl, 6000);
  if (direct.online) {
    const finalUrl = direct.resolvedUrl || cleanUrl;
    setStoredPiEndpoint(finalUrl);
    probeAndBridgeLanPi(finalUrl, true).catch(() => null);
    fetch(`${finalUrl}/api/config`, {
      method: 'POST',
      headers: getPiHeaders(finalUrl, true),
      body: JSON.stringify({ piServerUrl: finalUrl }),
    }).catch(() => null);

    return {
      success: true,
      online: true,
      normalizedUrl: finalUrl,
      latencyMs: direct.latencyMs,
      method: direct.connectionMethod,
      message:
        lang === 'tl'
          ? `Konektado at Nai-bind sa Raspberry Pi Cloud Server! (${direct.connectionMethod}, Bilis: ${direct.latencyMs}ms)`
          : `Connected & Bound to Raspberry Pi Cloud Server! (${direct.connectionMethod}, Latency: ${direct.latencyMs}ms)`,
    };
  }

  const errText =
    direct.errorDetail && direct.errorDetail.includes('Mixed Content')
      ? direct.errorDetail
      : serverPing.data?.error ||
        (lang === 'tl'
          ? `Hindi maabot o hindi valid ang Raspberry Pi Cloud Server sa ${cleanUrl}. Pakisiguradong tama ang link at online ang iyong Pi server.`
          : `Cannot reach or validate Raspberry Pi Cloud Server at ${cleanUrl}. Make sure the link is valid and your Pi server is running.`);

  return {
    success: false,
    online: false,
    normalizedUrl: '',
    message: errText,
    error: errText,
  };
}

export async function getUnifiedPiStatus(
  overrideEndpoint: string | undefined,
  lang: 'tl' | 'en'
): Promise<PiStatus> {
  const candidate =
    overrideEndpoint !== undefined ? normalizeClientPiUrl(overrideEndpoint) : getStoredPiEndpoint();

  if (candidate && isLocalLanUrl(candidate)) {
    await probeAndBridgeLanPi(candidate, false);
  }

  const params = new URLSearchParams({ lang });
  if (candidate) params.set('endpoint', candidate);

  const apiRes = await safePortalApiFetch(`/api/pi-status?${params.toString()}`, {}, 5500);
  if (apiRes.ok && apiRes.data && typeof apiRes.data === 'object') {
    const serverStatus = apiRes.data as PiStatus;
    if (serverStatus.online) {
      if (serverStatus.configuredUrl && !getStoredPiEndpoint()) {
        setStoredPiEndpoint(serverStatus.configuredUrl);
      }
      return serverStatus;
    }
  }

  // Fallback or secondary verification: Direct Browser-to-Pi Tunnel Probe
  const targetUrl = candidate || normalizeClientPiUrl(apiRes.data?.configuredUrl || '');
  if (targetUrl && !isBareTunnelRootDomain(targetUrl)) {
    const direct = await probeDirectPiFromBrowser(targetUrl, 5000);
    let hostname = 'raspberrypi.local';
    try {
      hostname = new URL(targetUrl).hostname;
    } catch {
      // ignore
    }

    if (direct.online) {
      const d = direct.healthJson || {};
      const rawTemp = parseFloat(String(d.cpu_temp || '42.0').replace(/[^\d.]/g, '')) || 42.0;
      const folderMb = Number(d.pulse_folder_mb ?? d.storageUsedMb ?? 0);
      return {
        online: true,
        isConfigured: true,
        configuredUrl: targetUrl,
        connectionMethod: direct.connectionMethod,
        latencyMs: direct.latencyMs,
        lastPingAt: new Date().toISOString(),
        hardware: d.hardware || 'Raspberry Pi 4 Model B',
        ram: d.ram || 'Active (Healthy)',
        storage_folder: d.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
        disk_total: d.disk_total || '500.0 GB',
        disk_used: d.disk_used || '20.0 GB',
        disk_free: d.disk_free || '480.0 GB',
        storageUsedMb: folderMb,
        pulseFolderMb: folderMb,
        pulseFolderKb: Number(d.pulse_folder_kb ?? Math.round(folderMb * 1024)),
        pulseStorageSummary:
          d.pulseStorageSummary ||
          `${folderMb.toFixed(2)} MB (${Number(d.pulse_folder_kb ?? Math.round(folderMb * 1024))} KB)`,
        residentPhotosCount: Number(d.residentPhotosCount ?? d.resident_photos_count ?? 0),
        residentPhotosMb: Number(d.residentPhotosMb ?? 0),
        proofPhotosCount: Number(d.proofPhotosCount ?? d.proof_photos_count ?? 0),
        proofPhotosMb: Number(d.proofPhotosMb ?? 0),
        cachedImagesCount: Number(d.cachedImagesCount ?? 0),
        activeTicketsCount: Number(d.reports_count ?? d.activeTicketsCount ?? 0),
        pendingTicketsCount: Number(d.pending_reports_count ?? d.pendingTicketsCount ?? 0),
        brgy40Count: Number(d.brgy40Count ?? 0),
        brgy41Count: Number(d.brgy41Count ?? 0),
        autoPurgeTtlDays: Number(d.autoPurgeTtlDays ?? AUTO_PURGE_TTL_DAYS),
        cpuTempCelsius: rawTemp,
        cpu_temp: d.cpu_temp || `${rawTemp.toFixed(1)}°C`,
        ipAddress: d.ipAddress || hostname,
        localHostname: d.localHostname || hostname,
        lastPurgeRun: d.lastPurgeRun || new Date().toISOString(),
        savedLogbooksCount: Number(d.saved_logbooks_count ?? d.savedLogbooksCount ?? 0),
        isPrivateLanIp: isLocalLanUrl(targetUrl),
        serverMode: 'DIRECT_CLOUD_TUNNEL',
      };
    }

    return {
      online: false,
      isConfigured: true,
      configuredUrl: targetUrl,
      connectionMethod: detectPiConnectionMethod(targetUrl),
      lastPingAt: new Date().toISOString(),
      errorDetail:
        direct.errorDetail ||
        apiRes.data?.errorDetail ||
        (lang === 'tl'
          ? 'Offline ang naka-link na Raspberry Pi Cloud Server.'
          : 'Linked Raspberry Pi Cloud Server is offline.'),
      hardware: 'Raspberry Pi 4 Model B',
      ram: 'Offline',
      storageUsedMb: 0,
      residentPhotosCount: 0,
      residentPhotosMb: 0,
      proofPhotosCount: 0,
      proofPhotosMb: 0,
      cachedImagesCount: 0,
      activeTicketsCount: 0,
      pendingTicketsCount: 0,
      autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
      cpuTempCelsius: 0,
      ipAddress: hostname,
      localHostname: hostname,
      lastPurgeRun: '',
      savedLogbooksCount: 0,
      isPrivateLanIp: isLocalLanUrl(targetUrl),
      serverMode: 'DIRECT_CLOUD_TUNNEL',
    };
  }

  if (apiRes.data && typeof apiRes.data === 'object' && 'online' in apiRes.data) {
    return apiRes.data as PiStatus;
  }

  return {
    online: false,
    isConfigured: false,
    configuredUrl: '',
    hardware: 'Raspberry Pi 4 Model B',
    ram: 'Not Configured',
    storageUsedMb: 0,
    residentPhotosCount: 0,
    residentPhotosMb: 0,
    proofPhotosCount: 0,
    proofPhotosMb: 0,
    cachedImagesCount: 0,
    activeTicketsCount: 0,
    pendingTicketsCount: 0,
    autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
    cpuTempCelsius: 0,
    ipAddress: 'Not Set',
    localHostname: 'raspberrypi.local',
    lastPurgeRun: '',
    savedLogbooksCount: 0,
    errorDetail:
      lang === 'tl' ? 'Walang naka-set na server link.' : 'No server link configured.',
  };
}

export async function syncUnifiedPiServer(
  rawUrl: string,
  lang: 'tl' | 'en'
): Promise<{ success: boolean; message: string }> {
  const cleanUrl = normalizeClientPiUrl(rawUrl || getStoredPiEndpoint());
  if (!cleanUrl) {
    return {
      success: false,
      message: lang === 'tl' ? 'Walang naka-set na Pi link.' : 'No Pi link configured.',
    };
  }

  // Try direct browser sync against Pi tunnel/LAN first so it works on all deployments
  const direct = await probeDirectPiFromBrowser(cleanUrl, 5000);
  if (direct.online) {
    await probeAndBridgeLanPi(cleanUrl, true).catch(() => null);
    return {
      success: true,
      message:
        lang === 'tl'
          ? 'Matagumpay na na-sync ang lahat ng ulat at litrato sa Raspberry Pi Hard Drive!'
          : 'Successfully synced all reports and photos with Raspberry Pi Hard Drive!',
    };
  }

  const res = await safePortalApiFetch(
    '/api/pi/sync',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanUrl, lang }),
    },
    8000
  );
  if (res.ok && res.data?.success) {
    return {
      success: true,
      message:
        res.data.message ||
        (lang === 'tl' ? 'Matagumpay na na-sync!' : 'Successfully synced!'),
    };
  }

  return {
    success: false,
    message:
      res.data?.error ||
      (lang === 'tl' ? 'Hindi ma-sync sa ngayon.' : 'Could not sync right now.'),
  };
}

export async function toggleCloudServerLock(
  lock: boolean,
  url: string,
  adminPassword: string,
  lang: 'tl' | 'en'
): Promise<{ success: boolean; locked: boolean; lockedUrl?: string; message: string }> {
  const cleanUrl = normalizeClientPiUrl(url || getStoredPiEndpoint());
  const apiRes = await safePortalApiFetch(
    '/api/pi/lock',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock, url: cleanUrl, adminPassword, lang }),
    },
    5000
  );

  if (apiRes.ok && apiRes.data?.success) {
    setClientCloudServerLock(
      Boolean(apiRes.data.locked),
      apiRes.data.lockedUrl || cleanUrl,
      apiRes.data.source || 'server_lock'
    );
    return {
      success: true,
      locked: Boolean(apiRes.data.locked),
      lockedUrl: apiRes.data.lockedUrl || cleanUrl,
      message:
        apiRes.data.message ||
        (lock
          ? lang === 'tl'
            ? 'Nai-lock na ang Cloud Server binding.'
            : 'Cloud Server binding is now locked.'
          : lang === 'tl'
            ? 'Na-unlock na ang Cloud Server binding.'
            : 'Cloud Server binding is now unlocked.'),
    };
  }

  return {
    success: false,
    locked: getCloudServerLockInfo().locked,
    message:
      apiRes.data?.error ||
      (lang === 'tl'
        ? 'Kailangan ng wastong Admin password upang baguhin ang Server Lock.'
        : 'Valid Admin password is required to modify Server Lock.'),
  };
}

export async function disconnectUnifiedPiServer(
  lang: 'tl' | 'en',
  adminPassword?: string
): Promise<{ success: boolean; error?: string }> {
  const lockInfo = getCloudServerLockInfo();
  const res = await safePortalApiFetch(
    '/api/pi/disconnect',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, adminPassword }),
    },
    4000
  );
  if (res.status === 403 || (lockInfo.locked && !res.data?.success)) {
    return {
      success: false,
      error:
        res.data?.error ||
        (lang === 'tl'
          ? 'Naka-lock ang Cloud Server binding. I-unlock muna gamit ang Admin credentials.'
          : 'Cloud Server binding is locked. Unlock first with Admin credentials.'),
    };
  }
  setClientCloudServerLock(false, '');
  setStoredPiEndpoint('');
  return { success: true };
}

export async function sendUnifiedPiPowerAction(
  action: 'shutdown' | 'reboot',
  rawUrl: string,
  lang: 'tl' | 'en'
): Promise<{ success: boolean; message: string }> {
  const cleanUrl = normalizeClientPiUrl(rawUrl || getStoredPiEndpoint());
  if (cleanUrl) {
    try {
      const directRes = await fetch(
        `${cleanUrl}/api/system/${action === 'reboot' ? 'reboot' : 'shutdown'}`,
        {
          method: 'POST',
          headers: getPiHeaders(cleanUrl, true),
        }
      );
      if (directRes.ok) {
        const d = await directRes.json().catch(() => ({}));
        return {
          success: true,
          message:
            d?.message ||
            (action === 'shutdown'
              ? lang === 'tl'
                ? 'Naipadala ang Safe Shutdown. Maghintay ng 5 segundo bago tanggalin sa saksakan.'
                : 'Safe Shutdown signal delivered. Wait 5 seconds before unplugging power.'
              : lang === 'tl'
              ? 'Nagre-reboot na ang Raspberry Pi!'
              : 'Raspberry Pi server is rebooting!'),
        };
      }
    } catch {}
  }

  const apiRes = await safePortalApiFetch(
    '/api/pi/system-action',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, url: cleanUrl, lang }),
    },
    6000
  );
  if (apiRes.ok && apiRes.data?.success) {
    return {
      success: true,
      message:
        apiRes.data.message ||
        (lang === 'tl' ? 'Naipadala ang command sa Pi.' : 'Command delivered to Pi.'),
    };
  }

  return {
    success: false,
    message:
      lang === 'tl' ? 'Nagkaroon ng aberya sa koneksyon sa Pi.' : 'Connection error reaching Pi.',
  };
}

/**
 * Unified Reports Fetching (Kagawad Queue + Per-Device Resident ?ids= Polling)
 */
export async function fetchUnifiedReports(
  lang: 'tl' | 'en',
  filterIds?: string[],
  options?: { force?: boolean }
): Promise<{ reports: WasteReport[]; piOnline: boolean | null; revision?: number }> {
  const piUrl = getStoredPiEndpoint();

  if (filterIds && filterIds.length === 0) {
    // Only check Pi online status
    if (piUrl) {
      const direct = await probeDirectPiFromBrowser(piUrl, 4000);
      if (direct.online) return { reports: [], piOnline: true };
    }
    const cfg = await safePortalApiFetch('/api/config', {}, 3500);
    if (cfg.ok && cfg.data) {
      return {
        reports: [],
        piOnline: Boolean(cfg.data.piOnline),
        revision: Number(cfg.data.portalRevision || 0) || undefined,
      };
    }
    return { reports: [], piOnline: piUrl ? false : null };
  }

  const params = new URLSearchParams({ lang });
  if (filterIds && filterIds.length > 0) {
    params.set('ids', filterIds.join(','));
  }
  if (options?.force) {
    params.set('_ts', String(Date.now()));
  }

  const apiRes = await safePortalApiFetch(`/api/reports?${params.toString()}`, { cache: 'no-store' }, 6500);
  if (apiRes.ok && Array.isArray(apiRes.data)) {
    const headerOnline = apiRes.headers?.get('X-Pi-Online');
    const revHeader = Number(apiRes.headers?.get('X-Portal-Revision') || 0) || undefined;
    const apiReports = (apiRes.data as WasteReport[]).map((r) => ({
      ...r,
      ticketNumber: formatTicketNumber(r.ticketNumber),
    }));

    // If a Pi tunnel/LAN URL is configured in browser and API returned empty or offline, also check direct Pi reports
    if (piUrl && (headerOnline === 'false' || apiReports.length === 0)) {
      try {
        const directRes = await fetch(`${piUrl}/api/reports`, {
          cache: 'no-store',
          headers: getPiHeaders(piUrl),
        });
        if (directRes.ok) {
          const directRev = Number(directRes.headers.get('X-Portal-Revision') || 0) || undefined;
          const directData = await directRes.json();
          if (Array.isArray(directData)) {
            let authoritative = directData.map((r: WasteReport) => enrichClientReport(r, lang));
            if (filterIds && filterIds.length > 0) {
              const idSet = new Set(filterIds);
              const canonicalSet = new Set(filterIds.map((f) => canonicalTicketKey(f)).filter(Boolean));
              authoritative = authoritative.filter(
                (r) =>
                  idSet.has(r.id) ||
                  idSet.has(r.ticketNumber) ||
                  canonicalSet.has(canonicalTicketKey(r.ticketNumber))
              );
            }
            return { reports: authoritative, piOnline: true, revision: directRev || revHeader };
          }
        }
      } catch {}
    }

    return {
      reports: apiReports,
      piOnline: headerOnline !== null ? headerOnline === 'true' : null,
      revision: revHeader,
    };
  }

  // Direct Browser-to-Pi Tunnel Fetch (Cloudflare Workers Static Assets / GitHub Pages / ngrok.dev)
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6500);
      const directRes = await fetch(`${piUrl}/api/reports`, {
        cache: 'no-store',
        signal: ctrl.signal,
        headers: getPiHeaders(piUrl),
      });
      clearTimeout(timer);

      if (directRes.ok) {
        const directRev = Number(directRes.headers.get('X-Portal-Revision') || 0) || undefined;
        const rawList = await directRes.json();
        if (Array.isArray(rawList)) {
          let enriched = rawList.map((r: WasteReport) => enrichClientReport(r, lang));
          if (filterIds && filterIds.length > 0) {
            const idSet = new Set(filterIds);
            const canonicalSet = new Set(filterIds.map((f) => canonicalTicketKey(f)).filter(Boolean));
            enriched = enriched.filter(
              (r) =>
                idSet.has(r.id) ||
                idSet.has(r.ticketNumber) ||
                canonicalSet.has(canonicalTicketKey(r.ticketNumber))
            );
          }
          return { reports: enriched, piOnline: true, revision: directRev };
        }
      }
      return { reports: [], piOnline: false };
    } catch {
      return { reports: [], piOnline: false };
    }
  }

  return { reports: [], piOnline: false };
}

/**
 * Safe Direct Push of a Single Report to Raspberry Pi Server:
 * Uses GET /api/reports + non-destructive merge + POST /api/reports/sync
 * so it is 100% compatible with BOTH older and newer server.py scripts!
 */
export async function pushSingleReportDirectToPi(
  piUrl: string,
  report: WasteReport
): Promise<boolean> {
  const cleanUrl = normalizeClientPiUrl(piUrl);
  if (!cleanUrl || isBareTunnelRootDomain(cleanUrl)) return false;

  try {
    const probe = await probeDirectPiFromBrowser(cleanUrl, 4500);
    if (!probe.online) return false;

    let existingList: WasteReport[] = [];
    try {
      const getCtrl = new AbortController();
      const getTimer = setTimeout(() => getCtrl.abort(), 6000);
      const getRes = await fetch(`${cleanUrl}/api/reports`, {
        signal: getCtrl.signal,
        headers: getPiHeaders(cleanUrl),
      });
      clearTimeout(getTimer);
      if (getRes.ok) {
        const parsed = await getRes.json();
        if (Array.isArray(parsed)) existingList = parsed;
      }
    } catch {}

    const nextReport: WasteReport = {
      ...report,
      localSyncStatus: 'SENT_TO_PI',
      sourceStorage: 'Raspberry Pi 4B Cloud Storage',
    };
    const merged = mergeWasteReportArrays([nextReport], existingList);

    const syncCtrl = new AbortController();
    const syncTimer = setTimeout(() => syncCtrl.abort(), 18000);
    const syncRes = await fetch(`${cleanUrl}/api/reports/sync`, {
      method: 'POST',
      signal: syncCtrl.signal,
      headers: getPiHeaders(cleanUrl, true),
      body: JSON.stringify(merged),
    }).catch(() => null);
    clearTimeout(syncTimer);

    if (syncRes && syncRes.ok) return true;

    const postCtrl = new AbortController();
    const postTimer = setTimeout(() => postCtrl.abort(), 15000);
    const postRes = await fetch(`${cleanUrl}/api/reports`, {
      method: 'POST',
      signal: postCtrl.signal,
      headers: getPiHeaders(cleanUrl, true),
      body: JSON.stringify(nextReport),
    }).catch(() => null);
    clearTimeout(postTimer);

    return Boolean(postRes && postRes.ok);
  } catch {
    return false;
  }
}

export async function submitUnifiedReport(
  draftReport: WasteReport,
  lang: 'tl' | 'en'
): Promise<{
  ok: boolean;
  piOffline: boolean;
  report?: WasteReport;
  error?: string;
}> {
  const piUrl = getStoredPiEndpoint();
  let directSynced = false;

  if (piUrl && isLocalLanUrl(piUrl)) {
    directSynced = await pushSingleReportDirectToPi(piUrl, draftReport);
  }

  const creds = await readTelegramCreds();
  const reportHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds.token) reportHeaders['X-Telegram-Token'] = creds.token;
  if (creds.chatId) reportHeaders['X-Telegram-Chat-Id'] = creds.chatId;

  const apiRes = await safePortalApiFetch(
    '/api/reports',
    {
      method: 'POST',
      headers: reportHeaders,
      body: JSON.stringify({
        ...draftReport,
        clientSyncedToPi: directSynced,
        telegramBotToken: creds.token || undefined,
        telegramChatId: creds.chatId || undefined,
        lang,
      }),
    },
    18000
  );

  if (apiRes.ok && apiRes.data?.report) {
    const submitted = apiRes.data.report as WasteReport;
    if (apiRes.data.telegramNotified !== true) {
      await notifyTelegramFromClient('NEW_REPORT', submitted, lang).catch(() => null);
    }
    broadcastPortalSyncToTabs('create', submitted.id);
    return {
      ok: true,
      piOffline: false,
      report: submitted,
    };
  }

  // If deployed on static Cloudflare Workers / Pages / GitHub Pages OR edge didn't know the browser's Pi tunnel URL:
  // Push directly from browser to the bound HTTPS tunnel (e.g. https://*.ngrok.dev, https://*.trycloudflare.com)!
  if (piUrl && !directSynced) {
    directSynced = await pushSingleReportDirectToPi(piUrl, draftReport);
  }

  if (directSynced) {
    const syncedReport: WasteReport = {
      ...draftReport,
      localSyncStatus: 'SENT_TO_PI',
      sourceStorage: 'Raspberry Pi 4B Cloud Storage',
    };
    await notifyTelegramFromClient('NEW_REPORT', syncedReport, lang).catch(() => null);
    broadcastPortalSyncToTabs('create', syncedReport.id);
    return {
      ok: true,
      piOffline: false,
      report: syncedReport,
    };
  }

  if (apiRes.status === 503 || apiRes.data?.piOffline || apiRes.isStaticFallback) {
    return {
      ok: false,
      piOffline: true,
      error: apiRes.data?.error,
    };
  }

  return {
    ok: false,
    piOffline: false,
    error: apiRes.data?.error,
  };
}

export interface UnifiedReportPatchPayload {
  status?: 'PENDING' | 'DISPATCHED' | 'RESOLVED' | 'CANCELLED';
  lang: 'tl' | 'en';
  dispatchedKagawad?: string;
  resolvedBy?: string;
  resolutionNotes?: string;
  cancellationReason?: string;
  proofPhotos?: string[];
  proofKagawadName?: string;
  residentName?: string;
  residentPhone?: string;
  barangay?: 'Barangay 40' | 'Barangay 41';
  purok?: string;
  streetAddress?: string;
  houseNumber?: string;
  landmark?: string;
  notes?: string;
  extraMessage?: string;
  severityLevel?: WasteReport['severityLevel'];
  isElderly?: boolean;
  updatedAt?: string;
}

export async function updateUnifiedReportStatus(
  id: string,
  payload: UnifiedReportPatchPayload
): Promise<{ success: boolean; report?: WasteReport; revision?: number }> {
  const creds = await readTelegramCreds();
  const patchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds.token) patchHeaders['X-Telegram-Token'] = creds.token;
  if (creds.chatId) patchHeaders['X-Telegram-Chat-Id'] = creds.chatId;

  const nowIso = payload.updatedAt || new Date().toISOString();
  const outgoingPayload: UnifiedReportPatchPayload = {
    ...payload,
    updatedAt: nowIso,
  };

  const apiRes = await safePortalApiFetch(
    `/api/reports/${encodeURIComponent(id)}/status`,
    {
      method: 'PATCH',
      headers: patchHeaders,
      body: JSON.stringify({
        ...outgoingPayload,
        telegramBotToken: creds.token || undefined,
        telegramChatId: creds.chatId || undefined,
      }),
    },
    15000
  );

  if (apiRes.ok && apiRes.data?.success && apiRes.data?.report) {
    const rawUpdated = apiRes.data.report as WasteReport;
    const updated: WasteReport = {
      ...rawUpdated,
      ticketNumber: formatTicketNumber(rawUpdated.ticketNumber),
    };
    const rev = Number(apiRes.data.revision || apiRes.headers?.get('X-Portal-Revision') || 0) || undefined;
    // Mirror to LAN Pi if configured
    const piUrl = getStoredPiEndpoint();
    if (piUrl && isLocalLanUrl(piUrl)) {
      pushSingleReportDirectToPi(piUrl, updated).catch(() => null);
    }
    if (payload.status === 'RESOLVED' && apiRes.data.telegramNotified !== true) {
      await notifyTelegramFromClient('RESOLVED_REPORT', updated, payload.lang).catch(() => null);
    }
    broadcastPortalSyncToTabs('update', updated.id, rev);
    return { success: true, report: updated, revision: rev };
  }

  // Direct Browser-to-Pi Tunnel Status / Edit Update (atomic PATCH first, fallback to GET + merge + sync)
  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    try {
      const patchRes = await fetch(`${piUrl}/api/reports/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: getPiHeaders(piUrl, true),
        body: JSON.stringify(outgoingPayload),
      }).catch(() => null);

      if (patchRes && patchRes.ok) {
        const patchData = await patchRes.json().catch(() => null);
        if (patchData?.success && patchData?.report) {
          const rev = Number(patchData.revision || patchRes.headers.get('X-Portal-Revision') || 0) || undefined;
          const patched = enrichClientReport(patchData.report as WasteReport, payload.lang);
          if (payload.status === 'RESOLVED') {
            await notifyTelegramFromClient('RESOLVED_REPORT', patched, payload.lang).catch(() => null);
          }
          broadcastPortalSyncToTabs('update', patched.id, rev);
          return { success: true, report: patched, revision: rev };
        }
      }

      const getRes = await fetch(`${piUrl}/api/reports`, {
        cache: 'no-store',
        headers: getPiHeaders(piUrl),
      });
      if (getRes.ok) {
        const list: WasteReport[] = await getRes.json();
        let updatedTarget: WasteReport | undefined;
        const targetCanonical = canonicalTicketKey(id);

        const nextList = (Array.isArray(list) ? list : []).map((r) => {
          if (
            r.id === id ||
            r.ticketNumber === id ||
            (targetCanonical && canonicalTicketKey(r.ticketNumber) === targetCanonical)
          ) {
            const next: WasteReport = {
              ...r,
              ticketNumber: formatTicketNumber(r.ticketNumber),
              updatedAt: nowIso,
            };
            if (payload.residentName !== undefined) next.residentName = payload.residentName;
            if (payload.residentPhone !== undefined) next.residentPhone = payload.residentPhone;
            if (payload.barangay !== undefined) next.barangay = payload.barangay;
            if (payload.purok !== undefined) next.purok = payload.purok;
            if (payload.streetAddress !== undefined) next.streetAddress = payload.streetAddress;
            if (payload.houseNumber !== undefined) next.houseNumber = payload.houseNumber;
            if (payload.landmark !== undefined) next.landmark = payload.landmark;
            if (payload.notes !== undefined) next.notes = payload.notes;
            if (payload.extraMessage !== undefined) next.extraMessage = payload.extraMessage;
            if (payload.severityLevel !== undefined) next.severityLevel = payload.severityLevel;
            if (typeof payload.isElderly === 'boolean') next.isElderly = payload.isElderly;
            if (payload.dispatchedKagawad !== undefined) next.dispatchedKagawad = payload.dispatchedKagawad;
            if (Array.isArray(payload.proofPhotos)) next.proofPhotos = payload.proofPhotos;

            if (payload.status) {
              next.status = payload.status;
              if (payload.status === 'PENDING') {
                delete next.dispatchedAt;
                if (payload.dispatchedKagawad === undefined) delete next.dispatchedKagawad;
              } else if (payload.status === 'DISPATCHED') {
                next.dispatchedAt = next.dispatchedAt || nowIso;
                next.dispatchedKagawad = payload.dispatchedKagawad || next.dispatchedKagawad || 'Barangay Official';
              } else if (payload.status === 'RESOLVED') {
                next.resolvedAt = nowIso;
                next.resolvedBy = payload.resolvedBy;
                next.resolutionNotes = payload.resolutionNotes;
                next.proofPhotos = payload.proofPhotos || next.proofPhotos || [];
                next.proofKagawadName = payload.proofKagawadName;
                next.proofSubmittedAt = nowIso;
              } else if (payload.status === 'CANCELLED') {
                next.cancelledAt = nowIso;
                next.cancellationReason = payload.cancellationReason;
              }
            }
            updatedTarget = next;
            return next;
          }
          return r;
        });

        if (updatedTarget) {
          const syncRes = await fetch(`${piUrl}/api/reports/sync`, {
            method: 'POST',
            headers: getPiHeaders(piUrl, true),
            body: JSON.stringify(nextList),
          });
          if (syncRes.ok) {
            if (payload.status === 'RESOLVED') {
              await notifyTelegramFromClient(
                'RESOLVED_REPORT',
                updatedTarget,
                payload.lang,
                nextList
              ).catch(() => null);
            }
            const enrichedTarget = enrichClientReport(updatedTarget, payload.lang);
            broadcastPortalSyncToTabs('update', enrichedTarget.id);
            return {
              success: true,
              report: enrichedTarget,
            };
          }
        }
      }
    } catch {}
  }

  return { success: false };
}

export async function updateUnifiedReport(
  id: string,
  payload: UnifiedReportPatchPayload
): Promise<{ success: boolean; report?: WasteReport; revision?: number }> {
  return updateUnifiedReportStatus(id, payload);
}

export async function deleteUnifiedReport(id: string): Promise<boolean> {
  let deleted = false;
  const apiRes = await safePortalApiFetch(
    `/api/reports/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    6000
  );
  if (apiRes.ok && apiRes.data?.success) {
    deleted = true;
  }

  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    try {
      const delRes = await fetch(`${piUrl}/api/reports?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: getPiHeaders(piUrl),
      });
      if (delRes.ok) deleted = true;
    } catch {}
  }

  if (deleted) {
    broadcastPortalSyncToTabs('delete', id);
  }
  return deleted;
}

export async function clearAllUnifiedReports(): Promise<boolean> {
  const apiRes = await safePortalApiFetch('/api/reports/clear-all', { method: 'POST' }, 6000);
  let cleared = Boolean(apiRes.ok && apiRes.data?.success);
  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    try {
      const clearRes = await fetch(`${piUrl}/api/reports/clear-all`, {
        method: 'POST',
        headers: getPiHeaders(piUrl, true),
      });
      if (clearRes.ok) {
        cleared = true;
      } else {
        const fallbackRes = await fetch(`${piUrl}/api/reports/sync`, {
          method: 'POST',
          headers: getPiHeaders(piUrl, true),
          body: JSON.stringify({ reports: [], replace: true }),
        });
        if (fallbackRes.ok) cleared = true;
      }
    } catch {}
  }
  if (cleared) {
    broadcastPortalSyncToTabs('clear');
  }
  return cleared;
}

export async function pushReportsToLanPiIfConfigured(reportsList: WasteReport[]): Promise<void> {
  const endpoint = getStoredPiEndpoint();
  if (!endpoint || !isLocalLanUrl(endpoint)) return;
  try {
    await fetch(`${endpoint}/api/reports/sync`, {
      method: 'POST',
      headers: getPiHeaders(endpoint, true),
      body: JSON.stringify(reportsList),
    });
  } catch {}
}

export async function deleteReportOnLanPiIfConfigured(reportId: string): Promise<void> {
  const endpoint = getStoredPiEndpoint();
  if (!endpoint || !isLocalLanUrl(endpoint)) return;
  try {
    await fetch(`${endpoint}/api/reports?id=${encodeURIComponent(reportId)}`, {
      method: 'DELETE',
      headers: getPiHeaders(endpoint),
    });
  } catch {}
}

/**
 * Unified Logbook Operations (Works across Express, Cloudflare Pages, and Direct Pi Tunnel/LAN)
 */
export async function fetchUnifiedSavedLogbooks(lang: 'tl' | 'en'): Promise<SavedLogBook[]> {
  let list: SavedLogBook[] = [];
  const apiRes = await safePortalApiFetch(`/api/pi/saved-logbooks?lang=${lang}`, {}, 5500);
  if (apiRes.ok && Array.isArray(apiRes.data?.logbooks)) {
    list = apiRes.data.logbooks;
  }

  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    try {
      const directRes = await fetch(`${piUrl}/api/logbooks`, {
        headers: getPiHeaders(piUrl),
      });
      if (directRes.ok) {
        const remLogs = await directRes.json();
        if (Array.isArray(remLogs)) {
          for (const rem of remLogs) {
            if (rem?.filename && !list.some((l) => l.filename === rem.filename)) {
              list = [
                {
                  id: rem.id || rem.filename,
                  filename: rem.filename,
                  savedAt: rem.modified || new Date().toISOString(),
                  savedAtPhilippineTime: rem.modified || new Date().toLocaleString(),
                  totalRecords: rem.totalRecords || 0,
                  pendingRecords: rem.pendingRecords || 0,
                  dispatchedRecords: rem.dispatchedRecords || 0,
                  resolvedRecords: rem.resolvedRecords || 0,
                  cancelledRecords: rem.cancelledRecords || 0,
                  brgy40Count: rem.brgy40Count || 0,
                  brgy41Count: rem.brgy41Count || 0,
                  storageUsedMb: rem.sizeKb ? +(rem.sizeKb / 1024).toFixed(2) : 0.1,
                  savedBy: rem.savedBy || 'Raspberry Pi Hard Drive',
                  destination: 'Raspberry Pi 4B Cloud Server',
                  syncStatus: 'SYNCED',
                  recordsSummary:
                    lang === 'tl'
                      ? 'Naka-imbak sa Raspberry Pi External Hard Drive'
                      : 'Stored on Raspberry Pi External Hard Drive',
                },
                ...list,
              ];
            }
          }
        }
      }
    } catch {}
  }

  return list;
}

export async function saveUnifiedLogbook(
  reports: WasteReport[],
  lang: 'tl' | 'en'
): Promise<{ success: boolean; logbook?: SavedLogBook; message?: string }> {
  const piEndpoint = getStoredPiEndpoint();
  const nowIso = new Date().toISOString();
  const phTime = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
  const genFilename = `TUGON_Logbook_Brgy40_41_${nowIso.slice(0, 10)}_${Date.now().toString().slice(-4)}.json`;
  const savedByLabel =
    lang === 'tl' ? 'Barangay 40 & 41 Kagawad' : 'Barangay 40 & 41 Official';

  let clientSyncedToPi = false;
  if (piEndpoint && !isBareTunnelRootDomain(piEndpoint)) {
    try {
      const piRes = await fetch(`${piEndpoint}/api/logbook/save`, {
        method: 'POST',
        headers: getPiHeaders(piEndpoint, true),
        body: JSON.stringify({
          filename: genFilename,
          savedAt: nowIso,
          savedAtPhilippineTime: phTime,
          savedBy: savedByLabel,
          totalRecords: reports.length,
          reports,
        }),
      });
      if (piRes.ok) {
        clientSyncedToPi = true;
      }
    } catch {}
  }

  const apiRes = await safePortalApiFetch(
    '/api/pi/save-logbook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        savedBy: savedByLabel,
        destination: 'Raspberry Pi 4B Cloud Server',
        piEndpoint,
        clientSyncedToPi,
        lang,
      }),
    },
    10000
  );

  if (apiRes.ok && apiRes.data?.success && apiRes.data?.logbook) {
    return {
      success: true,
      logbook: apiRes.data.logbook,
      message: apiRes.data.message,
    };
  }

  if (clientSyncedToPi) {
    const fallbackLogbook: SavedLogBook = {
      id: genFilename,
      filename: genFilename,
      savedAt: nowIso,
      savedAtPhilippineTime: phTime,
      totalRecords: reports.length,
      pendingRecords: reports.filter((r) => r.status === 'PENDING').length,
      dispatchedRecords: reports.filter((r) => r.status === 'DISPATCHED').length,
      resolvedRecords: reports.filter((r) => r.status === 'RESOLVED').length,
      cancelledRecords: reports.filter((r) => r.status === 'CANCELLED').length,
      brgy40Count: reports.filter((r) => r.barangay?.includes('40')).length,
      brgy41Count: reports.filter((r) => !r.barangay?.includes('40')).length,
      storageUsedMb: +(
        reports.reduce((acc, r) => acc + (r.storageUsedMb || 0.8), 0) || 0.1
      ).toFixed(2),
      savedBy: savedByLabel,
      destination: 'Raspberry Pi 4B Cloud Server',
      syncStatus: 'SYNCED',
      recordsSummary:
        lang === 'tl'
          ? 'Direktang na-save sa Raspberry Pi Hard Drive'
          : 'Saved directly to Raspberry Pi Hard Drive',
    };
    return {
      success: true,
      logbook: fallbackLogbook,
      message:
        lang === 'tl'
          ? `Matagumpay na na-save ang Log Book snapshot sa Pi Cloud Server! (${phTime})`
          : `Log Book snapshot successfully saved to Pi Cloud Server! (${phTime})`,
    };
  }

  return { success: false };
}

export async function downloadUnifiedLogbook(log: SavedLogBook): Promise<Blob | null> {
  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    try {
      const directRes = await fetch(
        `${piUrl}/api/logbooks/${encodeURIComponent(log.filename)}`,
        { headers: getPiHeaders(piUrl) }
      );
      if (directRes.ok) {
        return await directRes.blob();
      }
    } catch {}
  }

  try {
    const res = await fetch(`/api/pi/download-logbook/${encodeURIComponent(log.id)}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && !ct.includes('text/html')) {
      return await res.blob();
    }
  } catch {}
  return null;
}

export async function deleteUnifiedSavedLogbook(log: SavedLogBook): Promise<void> {
  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    await fetch(`${piUrl}/api/logbooks?filename=${encodeURIComponent(log.filename)}`, {
      method: 'DELETE',
      headers: getPiHeaders(piUrl),
    }).catch(() => null);
  }
  await safePortalApiFetch(
    `/api/pi/logbooks/${encodeURIComponent(log.id)}`,
    { method: 'DELETE' },
    5000
  );
}

/**
 * Unified Telegram Bot Support (Server / Edge + Direct Browser Fallback to api.telegram.org)
 */
async function readTelegramCreds(overrideToken?: string, overrideChatId?: string) {
  let token = (overrideToken || '').trim();
  let chatId = (overrideChatId || '').trim();
  try {
    if (!token) {
      token =
        localStorage.getItem('pulse_telegram_bot_token') ||
        localStorage.getItem('trash_telegram_bot_token') ||
        '';
    }
    if (!chatId) {
      chatId =
        localStorage.getItem('pulse_telegram_chat_id') ||
        localStorage.getItem('trash_telegram_chat_id') ||
        '';
    }
  } catch {}

  // If browser storage is empty (e.g. resident's phone), check Pi's /api/config
  if ((!token || !chatId) && getStoredPiEndpoint()) {
    try {
      const piUrl = getStoredPiEndpoint();
      const cfgRes = await fetch(`${piUrl}/api/config`, { headers: getPiHeaders(piUrl) });
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (!token && cfg?.telegramBotToken) token = String(cfg.telegramBotToken).trim();
        if (!chatId && cfg?.telegramChatId) chatId = String(cfg.telegramChatId).trim();
      }
    } catch {}
  }

  return { token, chatId };
}

async function sendTelegramClientPhoto(
  token: string,
  chatId: string,
  dataUrl: string,
  captionHtml: string,
  replyMarkup?: any
): Promise<boolean> {
  if (!token || !chatId || !dataUrl || !dataUrl.startsWith('data:image/')) return false;
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return false;
    const header = dataUrl.slice(0, commaIdx);
    const base64Data = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', captionHtml.slice(0, 950));
    formData.append('parse_mode', 'HTML');
    if (replyMarkup) formData.append('reply_markup', JSON.stringify(replyMarkup));
    formData.append('photo', new Blob([bytes], { type: mimeType }), `tugon_report.${ext}`);

    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });
    const parsed = await res.json().catch(() => ({ ok: false }));
    return Boolean(res.ok && parsed?.ok);
  } catch {
    return false;
  }
}

async function sendTelegramClientText(
  token: string,
  chatId: string,
  htmlText: string,
  replyMarkup?: any
): Promise<boolean> {
  if (!token || !chatId) return false;
  try {
    const payload: Record<string, any> = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const parsed = await res.json().catch(() => ({ ok: false }));
    if (res.ok && parsed?.ok) return true;

    const plainFull = htmlToPlainTelegramText(htmlText);
    const safePlain = plainFull.length > 3900 ? `${plainFull.slice(0, 3900)}\n...` : plainFull;
    const retryPayload: Record<string, any> = {
      chat_id: chatId,
      text: safePlain,
      disable_web_page_preview: true,
    };
    if (replyMarkup) retryPayload.reply_markup = replyMarkup;
    const retryRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(retryPayload),
    });
    const retryParsed = await retryRes.json().catch(() => ({ ok: false }));
    return Boolean(retryRes.ok && retryParsed?.ok);
  } catch {
    return false;
  }
}

async function notifyTelegramFromClient(
  eventType: 'NEW_REPORT' | 'RESOLVED_REPORT',
  report: WasteReport,
  lang: 'tl' | 'en',
  knownReports?: WasteReport[]
): Promise<void> {
  const { token, chatId } = await readTelegramCreds();
  if (!token || !chatId) return;

  // Fetch latest reports from Pi / API so Message 2 always lists every active & unresolved concern
  let allReports: WasteReport[] = Array.isArray(knownReports) ? [...knownReports] : [];
  if (allReports.length === 0) {
    try {
      const fetched = await fetchUnifiedReports(lang);
      allReports = mergeWasteReportArrays([report], fetched.reports);
    } catch {
      allReports = [report];
    }
  } else {
    allReports = mergeWasteReportArrays([report], allReports);
  }

  const phTime = getTelegramPhTime();

  // Message 1: New Concern Info (or Resolved Info)
  if (eventType === 'NEW_REPORT') {
    const msg1Html = buildNewConcernMessage1Html(report, lang, phTime);
    const inlineKb = buildNewConcernInlineKeyboard(report, lang);
    let m1Sent = false;
    if (Array.isArray(report.photos) && report.photos[0]?.startsWith('data:image/')) {
      const caption = buildNewConcernPhotoCaptionHtml(report, lang, phTime);
      m1Sent = await sendTelegramClientPhoto(token, chatId, report.photos[0], caption, inlineKb);
    }
    if (!m1Sent) {
      await sendTelegramClientText(token, chatId, msg1Html, inlineKb);
    }
  } else {
    const resolvedHtml = buildResolvedConcernMessage1Html(report, lang, phTime);
    await sendTelegramClientText(token, chatId, resolvedHtml);
  }

  // Message 2: Active & Unresolved Concerns List + Quick-Action Bubble Buttons
  const msg2Html = buildActiveUnresolvedConcernsMessage2Html(allReports, lang, 'ACTIVE');
  await sendTelegramClientText(
    token,
    chatId,
    msg2Html,
    buildTelegramReplyMarkupForChat(lang, chatId)
  );
}

export async function getUnifiedTelegramStatus(
  lang: 'tl' | 'en',
  token?: string,
  chatId?: string
): Promise<TelegramBotStatus> {
  const creds = await readTelegramCreds(token, chatId);
  const params = new URLSearchParams({ lang });
  if (creds.token) params.set('token', creds.token);
  if (creds.chatId) params.set('chatId', creds.chatId);

  const apiRes = await safePortalApiFetch(`/api/telegram/status?${params.toString()}`, {}, 5000);
  if (apiRes.ok && apiRes.data && typeof apiRes.data === 'object') {
    return apiRes.data as TelegramBotStatus;
  }

  const nowStr = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());

  if (!creds.token) {
    return {
      online: false,
      status: 'NOT_CONFIGURED',
      botConfigured: false,
      chatId: creds.chatId,
      botUsername: '',
      autoRestartCount: 0,
      reconnectAttempts: 0,
      lastCheckedAt: nowStr,
      watchdogActive: true,
    };
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${creds.token}/getMe`);
    const tgData = await tgRes.json();
    if (tgData?.ok && tgData.result) {
      return {
        online: true,
        status: 'ONLINE',
        botConfigured: Boolean(creds.token && creds.chatId),
        setupComplete: Boolean(creds.token && creds.chatId),
        chatId: creds.chatId,
        botUsername: tgData.result.username || '',
        autoRestartCount: 0,
        reconnectAttempts: 0,
        lastCheckedAt: nowStr,
        watchdogActive: true,
      };
    }
  } catch {}

  return {
    online: false,
    status: 'OFFLINE',
    botConfigured: Boolean(creds.token && creds.chatId),
    chatId: creds.chatId,
    botUsername: '',
    autoRestartCount: 0,
    reconnectAttempts: 0,
    lastCheckedAt: nowStr,
    watchdogActive: true,
  };
}

export async function restartUnifiedTelegram(
  lang: 'tl' | 'en',
  token?: string,
  chatId?: string
): Promise<TelegramBotStatus> {
  const creds = await readTelegramCreds(token, chatId);
  const apiRes = await safePortalApiFetch(
    '/api/telegram/restart',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lang,
        botToken: creds.token || undefined,
        chatId: creds.chatId || undefined,
      }),
    },
    6500
  );
  if (!apiRes.isStaticFallback && apiRes.data && typeof apiRes.data === 'object') {
    return apiRes.data as TelegramBotStatus;
  }
  return getUnifiedTelegramStatus(lang, creds.token, creds.chatId);
}

export async function detectUnifiedTelegramChat(
  botToken: string,
  lang: 'tl' | 'en'
): Promise<{
  success: boolean;
  chatId?: string;
  chatTitle?: string;
  chats?: { id: string; title: string; type: string }[];
  error?: string;
}> {
  const cleanToken = botToken.trim();
  const apiRes = await safePortalApiFetch(
    '/api/telegram/detect-chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: cleanToken, lang }),
    },
    6500
  );
  if (!apiRes.isStaticFallback && apiRes.data) {
    return apiRes.data;
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${cleanToken}/getUpdates?limit=25`);
    const data = await r.json();
    if (!data?.ok) {
      return {
        success: false,
        error:
          data?.description ||
          (lang === 'en' ? 'Invalid Bot Token.' : 'Invalid ang Bot Token.'),
      };
    }
    const chatsMap = new Map<string, { id: string; title: string; type: string }>();
    for (const upd of (data.result || []).reverse()) {
      const msg = upd.message || upd.channel_post || upd.callback_query?.message || upd.my_chat_member;
      const chat = msg?.chat;
      if (chat?.id) {
        const idStr = String(chat.id);
        if (!chatsMap.has(idStr)) {
          const title =
            chat.title ||
            [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
            chat.username ||
            `Chat ${idStr}`;
          chatsMap.set(idStr, { id: idStr, title, type: chat.type || 'private' });
        }
      }
    }
    const chats = Array.from(chatsMap.values());
    if (chats.length === 0) {
      return {
        success: false,
        error:
          lang === 'en'
            ? 'Open your bot in Telegram and send /start first, then click Auto-Detect again.'
            : 'Buksan muna ang iyong bot sa Telegram at i-tap ang /start, saka ulitin ang Auto-Detect.',
      };
    }
    return {
      success: true,
      chatId: chats[0].id,
      chatTitle: chats[0].title,
      chats,
    };
  } catch {
    return {
      success: false,
      error:
        lang === 'en'
          ? 'Could not reach Telegram API.'
          : 'Hindi makakonekta sa Telegram API.',
    };
  }
}

export async function configureUnifiedTelegram(
  botToken: string,
  chatId: string,
  lang: 'tl' | 'en'
): Promise<{ online: boolean; botUsername?: string; error?: string; message?: string }> {
  const cleanToken = botToken.trim();
  const cleanChat = chatId.trim();

  // Save to Pi /api/config if Pi is bound so resident phones can trigger Telegram alerts too
  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    fetch(`${piUrl}/api/config`, {
      method: 'POST',
      headers: getPiHeaders(piUrl, true),
      body: JSON.stringify({
        piServerUrl: piUrl,
        telegramBotToken: cleanToken,
        telegramChatId: cleanChat,
        telegramSetupComplete: true,
      }),
    }).catch(() => null);
  }

  const apiRes = await safePortalApiFetch(
    '/api/telegram/configure',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: cleanToken, chatId: cleanChat, lang }),
    },
    6500
  );
  if (!apiRes.isStaticFallback && apiRes.data) {
    return apiRes.data;
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const data = await r.json();
    if (data?.ok && data.result) {
      return {
        online: true,
        botUsername: data.result.username || '',
      };
    }
    return {
      online: false,
      error: data?.description || 'Invalid Telegram Bot Token.',
    };
  } catch {
    return {
      online: false,
      error:
        lang === 'en'
          ? 'Could not reach Telegram API.'
          : 'Hindi makakonekta sa Telegram API.',
    };
  }
}

export async function sendUnifiedTelegramTest(
  botToken: string,
  chatId: string,
  lang: 'tl' | 'en'
): Promise<{
  delivered: boolean;
  timestamp: string;
  broadcast: string;
  message?: string;
}> {
  const creds = await readTelegramCreds(botToken, chatId);
  const apiRes = await safePortalApiFetch(
    '/api/telegram/test-notify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botToken: creds.token || undefined,
        chatId: creds.chatId || undefined,
        lang,
      }),
    },
    7000
  );
  if (!apiRes.isStaticFallback && apiRes.data) {
    return {
      delivered: Boolean(apiRes.data.delivered || apiRes.data.telegramResult?.ok),
      timestamp: apiRes.data.timestamp || new Date().toLocaleTimeString(),
      broadcast: apiRes.data.broadcast || 'T.U.G.O.N. Test Alert',
      message: apiRes.data.message || apiRes.data.telegramResult?.description,
    };
  }

  const phTime = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date());
  const msgText =
    lang === 'en'
      ? `🔔 <b>[T.U.G.O.N. TEST ALERT - BARANGAY 40 &amp; 41]</b>\nStatus: Active &amp; Connected\nTime: ${phTime}\n\n💡 Tap any bubble button below anytime to check active concerns!`
      : `🔔 <b>[T.U.G.O.N. TEST ALERT - BARANGAY 40 &amp; 41]</b>\nStatus: Aktibo at Konektado\nOras: ${phTime}\n\n💡 Pindutin ang mga bubble button sa ibaba anumang oras para tingnan ang active concerns!`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text: msgText,
        parse_mode: 'HTML',
        reply_markup: buildTelegramReplyMarkupForChat(lang, creds.chatId),
      }),
    });
    const tgData = await tgRes.json();
    return {
      delivered: Boolean(tgData?.ok),
      timestamp: phTime,
      broadcast: htmlToPlainTelegramText(msgText),
      message: tgData?.description,
    };
  } catch {
    return {
      delivered: false,
      timestamp: phTime,
      broadcast: htmlToPlainTelegramText(msgText),
      message: lang === 'en' ? 'Network error.' : 'Nagkaroon ng network error.',
    };
  }
}

export async function disconnectUnifiedTelegram(lang: 'tl' | 'en'): Promise<void> {
  await safePortalApiFetch(
    '/api/telegram/disconnect',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang }),
    },
    4000
  );
  const piUrl = getStoredPiEndpoint();
  if (piUrl && !isBareTunnelRootDomain(piUrl)) {
    fetch(`${piUrl}/api/config`, {
      method: 'POST',
      headers: getPiHeaders(piUrl, true),
      body: JSON.stringify({
        telegramBotToken: '',
        telegramChatId: '',
        telegramSetupComplete: false,
      }),
    }).catch(() => null);
  }
}

const LOCAL_TG_CHAT_STORAGE_KEY = 'tugon_telegram_chat_history_v1';

function readLocalTelegramChatHistory(): TelegramChatMessage[] {
  try {
    const raw = localStorage.getItem(LOCAL_TG_CHAT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalTelegramChatHistory(messages: TelegramChatMessage[]) {
  try {
    localStorage.setItem(LOCAL_TG_CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-80)));
  } catch {}
}

export async function fetchUnifiedTelegramChat(
  botToken?: string,
  chatId?: string
): Promise<TelegramChatMessage[]> {
  const creds = await readTelegramCreds(botToken, chatId);
  const headers: Record<string, string> = {};
  if (creds.token) headers['X-Telegram-Token'] = creds.token;
  if (creds.chatId) headers['X-Telegram-Chat-Id'] = creds.chatId;

  const apiRes = await safePortalApiFetch('/api/telegram/chat', { headers }, 5500);
  if (apiRes.ok && Array.isArray(apiRes.data?.messages)) {
    const serverMsgs = apiRes.data.messages as TelegramChatMessage[];
    if (serverMsgs.length > 0) {
      writeLocalTelegramChatHistory(serverMsgs);
      return serverMsgs;
    }
  }
  return readLocalTelegramChatHistory();
}

export async function sendUnifiedTelegramChatMessage(options: {
  message: string;
  lang: 'tl' | 'en';
  sendToTelegram: boolean;
  botToken?: string;
  chatId?: string;
}): Promise<{
  messages: TelegramChatMessage[];
  telegramDelivered: boolean;
}> {
  const creds = await readTelegramCreds(options.botToken, options.chatId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds.token) headers['X-Telegram-Token'] = creds.token;
  if (creds.chatId) headers['X-Telegram-Chat-Id'] = creds.chatId;

  const apiRes = await safePortalApiFetch(
    '/api/telegram/chat',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: options.message,
        lang: options.lang,
        sendToTelegram: options.sendToTelegram,
        botToken: creds.token || undefined,
        chatId: creds.chatId || undefined,
      }),
    },
    7500
  );

  if (apiRes.ok && apiRes.data?.success && Array.isArray(apiRes.data?.messages)) {
    const serverMsgs = apiRes.data.messages as TelegramChatMessage[];
    writeLocalTelegramChatHistory(serverMsgs);
    return {
      messages: serverMsgs,
      telegramDelivered: Boolean(apiRes.data.telegramDelivered),
    };
  }

  // Client / static fallback: query live reports (Pi or local) and generate identical bot reply
  let liveReports: WasteReport[] = [];
  try {
    const fetched = await fetchUnifiedReports(options.lang);
    liveReports = fetched.reports;
  } catch {}

  const phTime = getTelegramPhTime();
  const userEntry: TelegramChatMessage = {
    id: `app-u-${Date.now()}`,
    sender: 'user',
    text: options.message.trim(),
    timestamp: phTime,
    source: 'app',
  };
  const reply = generateBotChatReply(options.message, liveReports, options.lang);
  const botEntry: TelegramChatMessage = {
    id: `app-b-${Date.now() + 1}`,
    sender: 'bot',
    text: reply.textPlain,
    timestamp: phTime,
    source: 'app',
    matchedIntent: reply.matchedIntent,
  };

  let telegramDelivered = false;
  if (options.sendToTelegram && creds.token && creds.chatId) {
    telegramDelivered = await sendTelegramClientText(
      creds.token,
      creds.chatId,
      reply.textHtml,
      buildTelegramReplyMarkupForChat(options.lang, creds.chatId)
    );
  }

  const next = [...readLocalTelegramChatHistory(), userEntry, botEntry].slice(-80);
  writeLocalTelegramChatHistory(next);
  return {
    messages: next,
    telegramDelivered,
  };
}

const PORTAL_SYNC_CHANNEL = 'tugon_barangay_portal_sync';
const PORTAL_SYNC_STORAGE_KEY = 'tugon_portal_sync_signal';

export function broadcastPortalSyncToTabs(
  reason = 'sync',
  reportId?: string,
  revision?: number
): void {
  if (typeof window === 'undefined') return;
  const payload = {
    reason,
    reportId,
    revision,
    ts: Date.now(),
  };
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel(PORTAL_SYNC_CHANNEL);
      bc.postMessage(payload);
      bc.close();
    }
  } catch {}
  try {
    localStorage.setItem(PORTAL_SYNC_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

/**
 * Subscribes a Barangay Portal session to real-time cross-device updates using:
 * 1. Native WebSocket (/ws/portal) on Express / self-hosted Node
 * 2. Server-Sent Events (/api/portal/events) on Express or Cloudflare Edge->Pi proxy
 * 3. BroadcastChannel + localStorage events for instant same-browser multi-tab sync
 * Resident Views never call this, keeping resident reports strictly isolated per device.
 */
export function subscribeToBarangayPortalSync(
  onSyncSignal: (event: { reason?: string; reportId?: string; revision?: number }) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  let closed = false;
  let lastTriggerAt = 0;
  let queuedTimer: ReturnType<typeof setTimeout> | null = null;
  let lastKnownRevision = 0;

  const scheduleSync = (info: { reason?: string; reportId?: string; revision?: number }) => {
    if (closed) return;
    if (typeof info.revision === 'number' && info.revision > 0) {
      if (info.revision <= lastKnownRevision && info.reason === 'portal:init') return;
      lastKnownRevision = Math.max(lastKnownRevision, info.revision);
    }
    const now = Date.now();
    if (now - lastTriggerAt >= 120) {
      lastTriggerAt = now;
      onSyncSignal(info);
      return;
    }
    if (!queuedTimer) {
      queuedTimer = setTimeout(() => {
        queuedTimer = null;
        if (!closed) {
          lastTriggerAt = Date.now();
          onSyncSignal(info);
        }
      }, 130);
    }
  };

  // 1. Same-browser multi-tab BroadcastChannel + storage fallback
  let bc: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(PORTAL_SYNC_CHANNEL);
      bc.onmessage = (ev) => {
        if (ev?.data) scheduleSync(ev.data);
      };
    }
  } catch {}

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== PORTAL_SYNC_STORAGE_KEY || !ev.newValue) return;
    try {
      const parsed = JSON.parse(ev.newValue);
      scheduleSync(parsed);
    } catch {}
  };
  window.addEventListener('storage', onStorage);

  // 2. Native WebSocket (/ws/portal) when Express backend supports WS upgrade
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsEverOpened = false;
  let wsAttempts = 0;

  const connectWs = () => {
    if (closed) return;
    try {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${wsProto}//${window.location.host}/ws/portal`);
      ws = socket;

      socket.onopen = () => {
        wsEverOpened = true;
        wsAttempts = 0;
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || '{}'));
          if (msg.type === 'portal:sync') {
            scheduleSync({
              reason: msg.reason || 'ws:sync',
              reportId: msg.reportId,
              revision: typeof msg.revision === 'number' ? msg.revision : undefined,
            });
          } else if (msg.type === 'portal:init' && typeof msg.revision === 'number') {
            if (lastKnownRevision > 0 && msg.revision > lastKnownRevision) {
              scheduleSync({ reason: 'ws:reconnect', revision: msg.revision });
            }
            lastKnownRevision = Math.max(lastKnownRevision, msg.revision);
          }
        } catch {}
      };

      socket.onclose = () => {
        if (closed) return;
        ws = null;
        // On Cloudflare Workers/Pages static/edge hosts that do not upgrade /ws/portal,
        // avoid repeated failed WS handshake attempts and rely on SSE + polling.
        if (!wsEverOpened) return;
        wsAttempts += 1;
        const delay = Math.min(8000, 1200 * Math.pow(1.5, Math.min(wsAttempts, 5)));
        wsReconnectTimer = setTimeout(connectWs, delay);
      };

      socket.onerror = () => {
        // Error immediately triggers onclose
      };
    } catch {}
  };
  connectWs();

  // 3. SSE (/api/portal/events) for both Express and Cloudflare Edge->Pi proxy
  let sse: EventSource | null = null;
  let sseEverOpened = false;
  let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connectSse = () => {
    if (closed || typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource('/api/portal/events');
      sse = es;

      es.onopen = () => {
        sseEverOpened = true;
      };

      es.addEventListener('portal-sync', (ev: MessageEvent) => {
        sseEverOpened = true;
        try {
          const msg = JSON.parse(String(ev.data || '{}'));
          if (msg.type === 'portal:sync') {
            scheduleSync({
              reason: msg.reason || 'sse:sync',
              reportId: msg.reportId,
              revision: typeof msg.revision === 'number' ? msg.revision : undefined,
            });
          } else if (msg.type === 'portal:init' && typeof msg.revision === 'number') {
            if (lastKnownRevision > 0 && msg.revision > lastKnownRevision) {
              scheduleSync({ reason: 'sse:reconnect', revision: msg.revision });
            }
            lastKnownRevision = Math.max(lastKnownRevision, msg.revision);
          }
        } catch {}
      });

      es.onerror = () => {
        es.close();
        sse = null;
        if (closed) return;
        // Stop SSE retries if static host returned non-SSE HTML fallback on first attempt
        if (!sseEverOpened) return;
        sseReconnectTimer = setTimeout(connectSse, 3000);
      };
    } catch {}
  };
  connectSse();

  return () => {
    closed = true;
    if (queuedTimer) clearTimeout(queuedTimer);
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    if (bc) {
      try {
        bc.close();
      } catch {}
    }
    window.removeEventListener('storage', onStorage);
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    if (sse) {
      try {
        sse.close();
      } catch {}
    }
  };
}

