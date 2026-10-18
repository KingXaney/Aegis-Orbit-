import { useEffect, useState } from 'react';
import { Badge } from '../components/ui';
import { describeFace, firingFace } from '../globe/thrusters';
import { useSimulation } from '../hooks/useSimulation';
import { formatCountdown, formatKm, formatUtc } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import type { CommittedManeuver } from '../types/api';

/** Simulated seconds before and after a burn during which the card shows. */
const SHOW_BEFORE_S = 60;
const SHOW_AFTER_S = 120;
/** Real milliseconds the card stays after the plume stops, so a 1800x clock cannot blink it away. */
const HOLD_MS = 6000;

type Phase = 'armed' | 'firing' | 'done';

const NO_BURNS: CommittedManeuver[] = [];

/** The secondary an id like CJ-<primary>-<secondary>-<tca> names, given the primary's id. */
function secondaryOf(conjunctionId: string, primaryId: string): string {
  const prefix = `CJ-${primaryId.replace('NORAD-', '')}-`;
  const body = conjunctionId.startsWith(prefix) ? conjunctionId.slice(prefix.length) : conjunctionId;
  return body.replace(/-\d+$/, '');
}

/**
 * The change of course a dodge burn makes, shown bottom right while the burn is near: which thruster
 * fires, the delta-v, how the pass changes, and a diagram of the velocity before and after (the delta-v
 * is drawn far larger than life: a quarter of a metre per second against seven and a half kilometres).
 */
export default function DodgeCard({ className = '' }: { className?: string }) {
  const sim = useSimulation();
  const committed = useAppStore((s) => s.simulation?.committed_maneuvers ?? NO_BURNS);
  const burnFiring = useAppStore((s) => s.burnFiring);
  const screening = useAppStore((s) => s.screening);
  const objects = useAppStore((s) => s.objects);
  const primaryId = useAppStore((s) => s.scenario?.primary_id ?? '');
  const now = sim.currentUnix;

  const firingBurn = burnFiring ? committed.find((m) => m.maneuver_id === burnFiring.maneuverId) ?? null : null;
  const nearBurn = committed
    .filter((m) => now >= m.burn_time_unix - SHOW_BEFORE_S && now <= m.burn_time_unix + SHOW_AFTER_S)
    .sort((a, b) => Math.abs(a.burn_time_unix - now) - Math.abs(b.burn_time_unix - now))[0] ?? null;
  const live = firingBurn ?? nearBurn;

  // hold the card a moment after the plume stops, whatever the clock speed
  const [held, setHeld] = useState<CommittedManeuver | null>(null);
  const firingId = firingBurn?.maneuver_id ?? null;
  useEffect(() => {
    if (firingBurn) setHeld(firingBurn);
  }, [firingId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!held || firingBurn) return;
    const t = setTimeout(() => setHeld(null), HOLD_MS);
    return () => clearTimeout(t);
  }, [held, firingBurn]);

  const m = live ?? held;
  if (!m) return null;
  const phase: Phase = firingBurn?.maneuver_id === m.maneuver_id ? 'firing' : now < m.burn_time_unix ? 'armed' : 'done';
  const face = firingFace(m.dv_rtn_mps);
  const nozzle = describeFace(face);
  const conj = screening?.conjunctions.find((c) => c.conjunction_id === m.conjunction_id) ?? null;
  const secondaryId = conj?.secondary_id ?? secondaryOf(m.conjunction_id, primaryId);
  const objectName = objects[secondaryId]?.name ?? secondaryId;
  const before = m.screening_miss_distance_km ?? m.baseline_miss_distance_km;

  // Diagram: along-track to the right, radial up; the delta-v exaggerated to a readable length.
  const dvT = m.dv_rtn_mps[1] ?? 0;
  const dvR = m.dv_rtn_mps[0] ?? 0;
  const dvN = m.dv_rtn_mps[2] ?? 0;
  const planar = Math.hypot(dvT, dvR);
  const ux = planar > 0 ? dvT / planar : 0;
  const uy = planar > 0 ? -dvR / planar : 0; // screen y grows downward
  const ARROW = 46;
  const ox = 64;
  const oy = 64;
  const vLen = 118;
  // the new velocity: the old one plus the exaggerated delta-v
  const nvx = vLen + ux * ARROW;
  const nvy = uy * ARROW;
  const grow = phase === 'armed' ? 0.25 : 1;
  const deflect = (phase === 'armed' ? 0 : 1) * (uy !== 0 ? uy * 22 : ux < 0 ? -10 : 10);

  return (
    <div className={className} aria-live="polite">
      <div className={`rounded border bg-panel/90 p-2.5 text-[10px] backdrop-blur transition-colors duration-300 ${phase === 'firing' ? 'border-[#a3e635] shadow-[0_0_18px_rgba(163,230,53,0.35)]' : 'border-line'}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Dodge burn</span>
          {phase === 'armed' && <Badge tone="warn">in {formatCountdown(m.burn_time_unix - now).slice(1)}</Badge>}
          {phase === 'firing' && <Badge tone="safe" className="motion-safe:animate-pulse">firing</Badge>}
          {phase === 'done' && <Badge tone="neutral">burned {formatCountdown(m.burn_time_unix - now).slice(1)} ago</Badge>}
        </div>
        <div className="mt-1 text-[11px] text-text">
          <span className="mono">{m.direction}</span> {m.dv_magnitude_mps.toFixed(2)} m/s · {nozzle.nozzle}
        </div>
        <div className="text-dim">{nozzle.effect}.</div>
        <svg viewBox="0 0 270 110" className="mt-1.5 w-full" role="img" aria-label={`Velocity before and after the burn; the pass with ${objectName} widens from ${formatKm(before)} to ${formatKm(m.post_miss_distance_km)}`}>
          <defs>
            <marker id="dodge-arrow-grey" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#64748b" /></marker>
            <marker id="dodge-arrow-teal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2dd4bf" /></marker>
            <marker id="dodge-arrow-lime" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#a3e635" /></marker>
            <filter id="dodge-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          {/* frame */}
          <text x="4" y="10" fill="#64748b" fontSize="8" fontFamily="JetBrains Mono, Menlo, monospace">R ↑  T →</text>
          {/* original path and the pass on it */}
          <path d={`M${ox},${oy} Q${ox + 95},${oy - 6} ${ox + 190},${oy - 10}`} fill="none" stroke="#67e8f9" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />
          <circle cx={ox + 176} cy={oy - 9} r="4" fill="#f87171" />
          <text x={ox + 176} y={oy - 16} textAnchor="middle" fill="#f87171" fontSize="8" fontFamily="JetBrains Mono, Menlo, monospace">{formatKm(before)}</text>
          {/* new path, deflected away from the pass */}
          <path
            d={`M${ox},${oy} Q${ox + 95},${oy - 6 + deflect} ${ox + 190},${oy - 10 + deflect * 2.2}`}
            fill="none"
            stroke="#2dd4bf"
            strokeWidth="2.5"
            style={{ transition: 'd 600ms ease-out, opacity 300ms', opacity: phase === 'armed' ? 0.35 : 1 }}
          />
          {phase !== 'armed' && (
            <text x={ox + 190} y={oy - 10 + deflect * 2.2 + (deflect >= 0 ? 12 : -6)} textAnchor="end" fill="#2dd4bf" fontSize="8" fontFamily="JetBrains Mono, Menlo, monospace">{formatKm(m.post_miss_distance_km)}</text>
          )}
          {/* velocity before and after */}
          <line x1={ox} y1={oy} x2={ox + vLen} y2={oy} stroke="#64748b" strokeWidth="2" markerEnd="url(#dodge-arrow-grey)" />
          <line
            x1={ox}
            y1={oy}
            x2={ox + nvx}
            y2={oy + nvy}
            stroke="#2dd4bf"
            strokeWidth="2.5"
            markerEnd="url(#dodge-arrow-teal)"
            style={{ transition: 'opacity 300ms', opacity: phase === 'armed' ? 0.3 : 1 }}
          />
          {/* the delta-v, from the tip of the old velocity */}
          <g style={{ transformOrigin: `${ox + vLen}px ${oy}px`, transform: `scale(${grow})`, transition: 'transform 400ms ease-out' }} filter={phase === 'firing' ? 'url(#dodge-glow)' : undefined}>
            <line x1={ox + vLen} y1={oy} x2={ox + vLen + ux * ARROW} y2={oy + uy * ARROW} stroke="#a3e635" strokeWidth="3" markerEnd="url(#dodge-arrow-lime)" />
          </g>
          <text x={ox + vLen + ux * ARROW + (ux >= 0 ? 6 : -6)} y={oy + uy * ARROW + (uy <= 0 ? -4 : 12)} textAnchor={ux >= 0 ? 'start' : 'end'} fill="#a3e635" fontSize="9" fontWeight="600" fontFamily="JetBrains Mono, Menlo, monospace">Δv</text>
          {Math.abs(dvN) > 1e-6 && <text x="4" y="104" fill="#64748b" fontSize="8" fontFamily="JetBrains Mono, Menlo, monospace">cross-track component {dvN > 0 ? '+' : '−'}{Math.abs(dvN).toFixed(2)} m/s</text>}
          {/* the spacecraft */}
          <circle cx={ox} cy={oy} r="4.5" fill="#67e8f9" stroke="#05080f" strokeWidth="1.5" />
          <text x={ox} y={oy + 16} textAnchor="middle" fill="#94a3b8" fontSize="8" fontFamily="JetBrains Mono, Menlo, monospace">v before (grey) · after (teal)</text>
        </svg>
        <div className="mt-1 text-muted">
          {objectName}: pass {formatKm(before)} → <span className="text-text">{formatKm(m.post_miss_distance_km)}</span> at {formatUtc(m.post_tca, false)}
        </div>
        <div className="text-dim">{m.source === 'autopilot' ? 'committed by the autopilot' : 'approved by you'} · burn at {formatUtc(m.burn_time, false)}</div>
      </div>
    </div>
  );
}
