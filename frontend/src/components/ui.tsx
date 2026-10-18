import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { THREAT_BG } from '../lib/format';

export function Badge({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: 'neutral' | 'threat' | 'safe' | 'warn' | 'info'; className?: string }) {
  const tones: Record<string, string> = {
    neutral: 'border-line text-muted',
    threat: 'border-threat/50 text-threat bg-threat/10',
    safe: 'border-safe/50 text-safe bg-safe/10',
    warn: 'border-warn/50 text-warn bg-warn/10',
    info: 'border-tracked/50 text-tracked bg-tracked/10',
  };
  return <span className={`inline-flex items-center whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[10px] font-medium leading-4 ${tones[tone]} ${className}`}>{children}</span>;
}

export function ThreatBadge({ state, large = false }: { state: string | null | undefined; large?: boolean }) {
  const s = state ?? 'NORMAL';
  const cls = THREAT_BG[s] ?? THREAT_BG.NORMAL;
  const pulse = s === 'CRITICAL' ? 'pulse' : '';
  return (
    <span className={`display inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] border uppercase tracking-[0.06em] ${cls} ${large ? 'px-2.5 py-1 text-[13px] leading-4' : 'px-1.5 py-px text-[11px] leading-4'}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${pulse}`} />
      {s}
    </span>
  );
}

export function Button({ children, variant = 'secondary', size = 'md', loading = false, className = '', disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'solid' | 'primary' | 'secondary' | 'danger' | 'ghost' | 'safe'; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const variants: Record<string, string> = {
    // the one main action on a surface
    solid: 'bg-primary border-primary text-bg font-bold hover:bg-primary-hover hover:border-primary-hover',
    primary: 'bg-primary/10 border-primary/70 text-primary hover:bg-primary/20',
    secondary: 'bg-panel-2 border-line-strong text-text hover:border-muted',
    danger: 'bg-threat/10 border-threat/50 text-threat hover:bg-threat/20',
    safe: 'bg-safe/10 border-safe/50 text-safe hover:bg-safe/20',
    ghost: 'bg-transparent border-transparent text-muted hover:text-text hover:border-line',
  };
  // px, not rem: the simulator's 13 px root would shrink rem heights below comfortable targets
  const sizes = { sm: 'h-[28px] px-2 text-[11px]', md: 'h-[32px] px-3 text-xs', lg: 'h-[40px] px-4 text-[13px]' };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 motion-reduce:active:scale-100 ${variants[variant]} ${sizes[size]} ${className}`}
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
        <h2 className="display text-[15px] leading-5 text-text">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, mono = true, className = '' }: { label: string; value: ReactNode; sub?: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[10px] text-dim">{label}</div>
      <div className={`truncate text-[13px] text-text ${mono ? 'mono' : ''}`}>{value}</div>
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
  return <div className="rounded-md border border-dashed border-line px-3 py-3 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-md border border-threat/40 bg-threat/10 px-3 py-2 text-[11px] text-threat">{children}</div>;
}

export function Toggle({ label, checked, onChange, swatch }: { label: string; checked: boolean; onChange: () => void; swatch?: string }) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2 text-[11px] text-muted hover:text-text">
      <input type="checkbox" role="switch" checked={checked} onChange={onChange} className="switch" />
      {swatch && <span className="inline-block h-1.5 w-4 rounded-sm" style={{ background: swatch }} />}
      {label}
    </label>
  );
}

export function Details({ summary, children, open = false }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer select-none rounded py-0.5 text-[11px] text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-primary">{summary}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
