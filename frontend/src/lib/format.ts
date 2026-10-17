export function formatUtc(iso: string | number | null | undefined, withDate = true): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const time = `${hh}:${mm}:${ss}`;
  if (!withDate) return `${time} UTC`;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da} ${time} UTC`;
}

export function formatCountdown(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '+' : '−';
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `T${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  const sec = s % 60;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

export function formatKm(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1) return `${(value * 1000).toFixed(0)} m`;
  return `${value.toFixed(digits)} km`;
}

export function formatPc(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  if (value === 0) return '< 1e-30';
  if (value < 1e-30) return '< 1e-30';
  return value.toExponential(2);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function pcLabel(pc: { status: string; value: number | null; covariance_basis: string } | null | undefined): string {
  if (!pc || pc.status !== 'COMPUTED' || pc.value === null) return 'UNVERIFIED';
  const basis = pc.covariance_basis === 'PROVIDED' ? '' : ' (illustrative)';
  return `${formatPc(pc.value)}${basis}`;
}

export const THREAT_COLORS: Record<string, string> = {
  NORMAL: 'text-safe',
  MONITORING: 'text-tracked',
  ELEVATED: 'text-warn',
  CRITICAL: 'text-threat',
  MITIGATED: 'text-safe',
  UNVERIFIED: 'text-accent',
};

export const THREAT_BG: Record<string, string> = {
  NORMAL: 'bg-safe/15 border-safe/40 text-safe',
  MONITORING: 'bg-tracked/15 border-tracked/40 text-tracked',
  ELEVATED: 'bg-warn/15 border-warn/40 text-warn',
  CRITICAL: 'bg-threat/15 border-threat/50 text-threat',
  MITIGATED: 'bg-safe/15 border-safe/40 text-safe',
  UNVERIFIED: 'bg-accent/15 border-accent/40 text-accent',
};
