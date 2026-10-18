import { useEffect } from 'react';
import { Badge, Button, ErrorText, Section, Spinner } from '../components/ui';
import { useSimulation } from '../hooks/useSimulation';
import { formatCountdown, formatKm, formatUtc } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import { IDLE, LAST_STEP, funnelRows, verdictFor, type FunnelStepKey, type Verdict } from './funnel';
import { startPerceptionSync, usePerceptionStore, type Decision } from './store';
import type { PerceptionObject } from './types';

// The ML perception funnel and the operator's decision, at the top of the mission panel on the
// full-catalog real ISS scenario (renders nothing elsewhere).

const DRILL_SOURCE = 'drill';

const BAR: Record<FunnelStepKey, string> = {
  tracked: 'bg-tracked/60',
  flagged: 'bg-warn/70',
  screened: 'bg-primary/70',
  confirmed: 'bg-warn',
  critical: 'bg-threat',
};

const fmt = (x: number) => x.toLocaleString('en-US');

function FunnelList({ injected }: { injected: number }) {
  const perception = usePerceptionStore((s) => s.perception);
  const step = usePerceptionStore((s) => s.step);
  if (!perception?.funnel) return null;
  const rows = funnelRows(perception.funnel, perception, injected);
  const top = Math.log10(rows[0].count + 1);
  return (
    <ol className="space-y-1.5" aria-live="polite" aria-label="ML perception funnel">
      {rows.map((r, i) => {
        const shown = i <= step;
        const width = top > 0 ? Math.max(2, (Math.log10(r.count + 1) / top) * 100) : 0;
        const tone = r.key === 'critical' ? (r.count > 0 ? 'text-threat' : 'text-safe') : 'text-text';
        return (
          <li key={r.key} className={`transition-opacity duration-500 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`} aria-hidden={!shown}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-muted">{r.label}</span>
              <span className={`mono text-sm font-semibold ${tone}`}>{fmt(r.count)}</span>
            </div>
            <div className="mt-0.5 h-1 w-full rounded-full bg-panel-2">
              <div className={`h-1 rounded-full ${BAR[r.key]} transition-[width] duration-700 motion-reduce:transition-none`} style={{ width: shown ? `${width}%` : '0%' }} />
            </div>
            <div className="mt-0.5 text-[10px] text-muted">{r.detail}</div>
          </li>
        );
      })}
    </ol>
  );
}

function passLine(o: PerceptionObject, nowUnix: number): string {
  const t = o.physics.tca_unix;
  const when = t === null ? '' : ` at ${formatUtc(t, false).slice(0, 8)} UTC (${t >= nowUnix ? formatCountdown(t - nowUnix) : 'passed'})`;
  return `${o.name.trim()} passes ${formatKm(o.physics.miss_distance_km)} from the station${when}`;
}

export interface DecisionCardProps {
  verdict: Verdict;
  nowUnix: number;
  decision: Decision | null;
  /** Object ids that are drill threats (badged as such). */
  drillIds: string[];
  canDrill: boolean;
  drillLoading: boolean;
  planLoading: boolean;
  onDecide: (kind: Decision['kind']) => void;
  onDrill: () => void;
}

export function DecisionCard({ verdict, nowUnix, decision, drillIds, canDrill, drillLoading, planLoading, onDecide, onDrill }: DecisionCardProps) {
  if (verdict.kind === 'stay') {
    const c = verdict.closest;
    return (
      <div className="rounded border border-safe/40 bg-safe/5 px-3 py-2" role="status">
        <div className="flex items-center gap-2">
          <Badge tone="safe">No action needed</Badge>
          <span className="text-[11px] font-semibold text-text">Recommendation: stay on course</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          {c ? (
            <>
              Closest pass: {passLine(c, nowUnix)}, outside the {verdict.criticalKm} km critical radius.
              {c.physics.pc?.status !== 'COMPUTED' && ' Its probability is UNVERIFIED: public elements carry no covariance.'}
            </>
          ) : (
            'No physics-verified pass inside the tracked radius.'
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="safe" disabled={decision?.kind === 'stay'} onClick={() => onDecide('stay')}>
            {decision?.kind === 'stay' ? 'Staying on course' : 'Acknowledge: stay on course'}
          </Button>
          {canDrill && (
            <Button size="sm" variant="ghost" loading={drillLoading} onClick={onDrill} title="Inject one labelled synthetic threat to rehearse the alert and maneuver flow">
              Run drill
            </Button>
          )}
        </div>
        {decision?.kind === 'stay' && <p className="mt-1.5 text-[10px] text-muted">Decision recorded at {formatUtc(decision.atUnix, false).slice(0, 8)} UTC (simulation time).</p>}
      </div>
    );
  }
  const first = verdict.threats[0];
  const isDrill = drillIds.includes(first.object_id);
  return (
    <div className="rounded border border-threat/50 bg-threat/10 px-3 py-2" role="alert">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="threat">Operator alert</Badge>
        {isDrill && <Badge tone="warn">Drill</Badge>}
        <span className="text-[11px] font-semibold text-text">
          {verdict.threats.length === 1 ? 'A pass inside the critical radius' : `${verdict.threats.length} passes inside the critical radius`}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-text">{passLine(first, nowUnix)}, inside the {verdict.criticalKm} km critical radius.</p>
      {isDrill && <p className="mt-1 text-[10px] text-warn">This is an injected test threat, not a catalogued object.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="danger" loading={planLoading} disabled={decision?.kind === 'maneuver'} onClick={() => onDecide('maneuver')}>
          Plan avoidance maneuver
        </Button>
        <Button size="sm" variant="ghost" disabled={decision?.kind === 'stay'} onClick={() => onDecide('stay')}>
          Stay on course
        </Button>
      </div>
      {decision?.kind === 'maneuver' && (
        <p className="mt-1.5 text-[10px] text-muted">Compare the candidates under Candidate maneuvers, then approve or reject one in Human decision.</p>
      )}
      {decision?.kind === 'stay' && (
        <p className="mt-1.5 text-[10px] text-muted">Decision recorded at {formatUtc(decision.atUnix, false).slice(0, 8)} UTC: stay on course. The pass stays inside the critical radius.</p>
      )}
    </div>
  );
}

export default function PerceptionSection() {
  useEffect(() => startPerceptionSync(), []);
  const active = usePerceptionStore((s) => s.active);
  const rows = usePerceptionStore((s) => s.rows);
  const rowsLoading = usePerceptionStore((s) => s.rowsLoading);
  const rowsError = usePerceptionStore((s) => s.rowsError);
  const cloudError = usePerceptionStore((s) => s.cloudError);
  const perception = usePerceptionStore((s) => s.perception);
  const loading = usePerceptionStore((s) => s.loading);
  const error = usePerceptionStore((s) => s.error);
  const step = usePerceptionStore((s) => s.step);
  const playing = usePerceptionStore((s) => s.playing);
  const decision = usePerceptionStore((s) => s.decision);
  const drillLoading = usePerceptionStore((s) => s.drillLoading);
  const drillError = usePerceptionStore((s) => s.drillError);
  const run = usePerceptionStore((s) => s.run);
  const skip = usePerceptionStore((s) => s.skip);
  const decide = usePerceptionStore((s) => s.decide);
  const injectDrill = usePerceptionStore((s) => s.injectDrill);
  const runCommitted = usePerceptionStore((s) => s.runCommitted);
  const objects = useAppStore((s) => s.objects);
  const planLoading = useAppStore((s) => s.planLoading);
  const committedNow = useAppStore((s) => s.simulation?.committed_maneuvers?.length ?? 0);
  const sim = useSimulation();
  if (!active) return null;

  const drillIds = Object.values(objects).filter((o) => o.source === DRILL_SOURCE).map((o) => o.object_id);
  const done = !!perception && step >= LAST_STEP;
  const tracked = rows?.length ?? null;
  const right = playing ? (
    <Button size="sm" variant="ghost" onClick={skip}>Skip</Button>
  ) : (
    <Button size="sm" variant="primary" loading={loading} disabled={!rows} onClick={() => void run()}>
      {perception ? 'Run again' : 'Run ML perception'}
    </Button>
  );

  return (
    <Section title="ML perception" right={right}>
      {rowsError && <ErrorText>Could not load the catalog for the point cloud: {rowsError}</ErrorText>}
      {cloudError && <ErrorText>The point cloud stopped updating: {cloudError}</ErrorText>}
      {!perception && !loading && !error && (
        <p className="text-[11px] leading-relaxed text-muted">
          {rowsLoading || tracked === null ? (
            <span className="flex items-center gap-2"><Spinner /> Loading the tracked catalog…</span>
          ) : (
            <>
              The globe shows all {fmt(tracked)} objects in the public catalog, tracked from the ground. The ML model scores every one of them
              against the station in milliseconds; physics screens only the shortlist, and you decide what to do about what it confirms.
            </>
          )}
        </p>
      )}
      {loading && <div className="flex items-center gap-2 text-[11px] text-muted"><Spinner /> Scoring the catalog and screening the shortlist…</div>}
      {error && <ErrorText>Perception failed: {error}</ErrorText>}
      {perception && step > IDLE && (
        <div className="space-y-3">
          {done && runCommitted !== committedNow && (
            <div className="rounded border border-tracked/40 bg-tracked/10 px-3 py-2 text-[11px] text-tracked" role="status">
              The trajectory changed after this run (a burn was {committedNow > runCommitted ? 'approved' : 'withdrawn'}). Run perception again to screen the new path.
            </div>
          )}
          <FunnelList injected={drillIds.length} />
          {done && (
            <DecisionCard
              verdict={verdictFor(perception)}
              nowUnix={sim.currentUnix}
              decision={decision}
              drillIds={drillIds}
              canDrill={drillIds.length === 0}
              drillLoading={drillLoading}
              planLoading={planLoading}
              onDecide={(k) => void decide(k)}
              onDrill={() => void injectDrill()}
            />
          )}
          {drillError && <ErrorText>Drill failed: {drillError}</ErrorText>}
          {done && (
            <p className="text-[10px] leading-relaxed text-muted">
              {perception.model.library ?? 'model'} {perception.model.model_version ?? ''} · scoring and screening took {perception.stats.duration_s.toFixed(2)} s.
              The model only ranks; every distance and time shown is computed by the physics screening.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
