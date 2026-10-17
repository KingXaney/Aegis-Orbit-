import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { THREAT_BG } from '../lib/format';

export function Badge({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: 'neutral' | 'threat' | 'safe' | 'warn' | 'info'; className?: string }) {
  const tones: Record<string, string> = {
    neutral: 'border-line-strong text-muted',
    threat: 'border-threat/50 text-threat bg-threat/10',
    safe: 'border-safe/50 text-safe bg-safe/10',
    warn: 'border-warn/50 text-warn bg-warn/10',
    info: 'border-tracked/50 text-tracked bg-tracked/10',
  };
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tones[tone]} ${className}`}>{children}</span>;
}

export function ThreatBadge({ state, large = false }: { state: string | null | undefined; large?: boolean }) {
  const s = state ?? 'NORMAL';
  const cls = THREAT_BG[s] ?? THREAT_BG.NORMAL;
  const pulse = s === 'CRITICAL' ? 'pulse' : '';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border font-semibold uppercase tracking-widest ${cls} ${large ? 'px-3 py-1.5 text-xs' : 'px-2 py-0.5 text-[10px]'}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${pulse}`} />
      {s}
    </span>
  );
}

export function Button({ children, variant = 'secondary', size = 'md', loading = false, className = '', disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'safe'; size?: 'sm' | 'md'; loading?: boolean }) {
  const variants: Record<string, string> = {
    primary: 'bg-primary/15 border-primary/60 text-primary hover:bg-primary/25',
    secondary: 'bg-panel-2 border-line-strong text-text hover:border-muted',
    danger: 'bg-threat/10 border-threat/50 text-threat hover:bg-threat/20',
    safe: 'bg-safe/10 border-safe/50 text-safe hover:bg-safe/20',
    ghost: 'bg-transparent border-transparent text-muted hover:text-text hover:border-line',
  };
  const sizes = { sm: 'px-2 py-1 text-[11px]', md: 'px-3 py-1.5 text-xs' };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent ${className}`} aria-hidden="true" />;
}

export function Section({ title, children, right, className = '' }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`border-b border-line px-4 py-3 ${className}`}>
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, mono = true, className = '' }: { label: string; value: ReactNode; sub?: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className={`truncate text-sm text-text ${mono ? 'mono' : ''}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-dim">{k}</dt>
          <dd className="mono truncate text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-line px-3 py-3 text-[11px] text-muted">{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <div className="rounded border border-threat/40 bg-threat/10 px-3 py-2 text-[11px] text-threat">{children}</div>;
}

export function Toggle({ label, checked, onChange, swatch }: { label: string; checked: boolean; onChange: () => void; swatch?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted hover:text-text">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-3 w-3 accent-cyan-300" />
      {swatch && <span className="inline-block h-1.5 w-4 rounded-sm" style={{ background: swatch }} />}
      {label}
    </label>
  );
}

export function Details({ summary, children, open = false }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer select-none text-[11px] text-muted hover:text-text">{summary}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}


export function ViewFrame({ mini, label, onSwap, children }: { mini: boolean; label: string; onSwap: () => void; children: ReactNode }) {
  return (
    <div className="relative h-full w-full">
      {children}
      {mini && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-2 py-1">
          <span className="rounded bg-panel/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted">{label}</span>
          <button onClick={onSwap} className="pointer-events-auto rounded border border-line bg-panel/90 px-1.5 py-0.5 text-[10px] text-text hover:border-muted" title="Make this the main view" aria-label={`Show ${label} full size`}>
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}
