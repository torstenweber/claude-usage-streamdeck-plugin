// usage-core.ts — data + rendering logic, no Stream Deck SDK dependency.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const DEFAULT_UA = "claude-code/2.0.31";
const CACHE_TTL_MS = 55_000;

export type UsageNode = { utilization: number; resets_at: string | null };
export type UsageData = {
  five_hour?: UsageNode | null;
  seven_day?: UsageNode | null;
  seven_day_opus?: UsageNode | null;
  seven_day_sonnet?: UsageNode | null;
  [k: string]: unknown;
};

export type FetchResult = { data: UsageData | null; error?: string };

// Module-level cache shared across all key instances in the plugin process,
// so 3-4 keys produce a single network call per minute, not 3-4.
let cache: { at: number; data: UsageData | null } = { at: 0, data: null };

export function credentialsPath(): string {
  // Windows: %USERPROFILE%\.claude\.credentials.json  (homedir() resolves USERPROFILE)
  // Linux:   ~/.claude/.credentials.json
  // macOS:   stored in Keychain instead (file fallback handled by caller if present)
  return join(homedir(), ".claude", ".credentials.json");
}

export function readToken(): { token?: string; expired?: boolean } {
  try {
    const raw = readFileSync(credentialsPath(), "utf8");
    const j = JSON.parse(raw);
    const o = (j && j.claudeAiOauth) || {};
    const token: string | undefined = o.accessToken;
    const expiresAt = Number(o.expiresAt || 0);
    const expired = expiresAt > 0 && Date.now() > expiresAt;
    return { token, expired };
  } catch {
    return {};
  }
}

export async function fetchUsage(ua: string, force = false): Promise<FetchResult> {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return { data: cache.data };
  }
  const { token } = readToken();
  if (!token) return { data: cache.data, error: "no-token" };

  try {
    const res = await fetch(ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        // Required: without a claude-code User-Agent the endpoint serves an
        // aggressively rate-limited bucket and returns persistent 429s.
        "User-Agent": ua || DEFAULT_UA,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) return { data: cache.data, error: `http-${res.status}` };
    const data = (await res.json()) as UsageData;
    cache = { at: now, data };
    return { data };
  } catch {
    return { data: cache.data, error: "network" };
  }
}

export const METRICS: Record<string, { label: string; key: keyof UsageData }> = {
  session: { label: "Session", key: "five_hour" },
  weekly: { label: "Weekly", key: "seven_day" },
  weekly_opus: { label: "Opus 7d", key: "seven_day_opus" },
  weekly_sonnet: { label: "Sonn 7d", key: "seven_day_sonnet" },
};

export function pickMetric(
  data: UsageData | null,
  metric: string,
): { label: string; pct: number | null; resetsAt: string | null } {
  const m = METRICS[metric] || METRICS.session;
  const node = data ? (data[m.key] as UsageNode | null | undefined) : null;
  if (!node || typeof node.utilization !== "number") {
    return { label: m.label, pct: null, resetsAt: null };
  }
  return { label: m.label, pct: node.utilization, resetsAt: node.resets_at ?? null };
}

export function untilText(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  let s = Math.max(0, Math.floor((t - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function color(pct: number | null, warn: number, crit: number): string {
  if (pct == null) return "#6b7280"; // gray — no data
  if (pct >= crit) return "#ef4444"; // red
  if (pct >= warn) return "#f59e0b"; // amber
  return "#22c55e"; // green
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function svgKey(opts: {
  label: string;
  pct: number | null;
  note: string;
  col: string;
  stale: boolean;
}): string {
  const size = 144;
  const cx = 72;
  const cy = 73; // ring center nudged up so the bottom note has room
  const r = 38; // smaller radius so the label above and note below both clear the ring
  const sw = 9; // thinner stroke leaves more room for the number inside
  const circ = 2 * Math.PI * r;
  const p = opts.pct == null ? 0 : Math.max(0, Math.min(100, opts.pct));
  const dash = (p / 100) * circ;
  const pctText = opts.pct == null ? "--" : `${Math.round(opts.pct)}%`;
  // Shrink the number for 4-char values like "100%" so it always fits inside the ring.
  const pctSize = pctText.length >= 4 ? 22 : 28;
  const pctBaseline = cy + Math.round(pctSize * 0.34); // optical vertical centering
  const noteFill = opts.stale ? "#f59e0b" : "#9ca3af";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="20" fill="#0f1216"/>
  <text x="${cx}" y="20" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" fill="#e5e7eb">${esc(opts.label)}</text>
  <g transform="rotate(-90 ${cx} ${cy})">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a4250" stroke-width="${sw}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${opts.col}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}"/>
  </g>
  <text x="${cx}" y="${pctBaseline}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${pctSize}" font-weight="800" fill="#ffffff">${pctText}</text>
  <text x="${cx}" y="134" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${noteFill}">${esc(opts.note)}</text>
</svg>`;
}

export function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
