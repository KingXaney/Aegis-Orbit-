import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useSimulation } from '../hooks/useSimulation';
import { Badge, Button, Details, Empty, ErrorText, KeyValue, Section, Spinner, Stat, ThreatBadge } from '../components/ui';
import { formatCountdown, formatDuration, formatKm, formatPc, formatUtc, pcLabel } from '../lib/format';
import type { Conjunction, Maneuver } from '../types/api';
import CandidateChart from './CandidateChart';

function PanelHeader() {
  const scenario = useAppStore((s) => s.scenario);
  const simulation = useAppStore((s) => s.simulation);
  const sim = useSimulation();
  return (
    <header className="border-b border-line px-4 py-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">Mission intelligence</div>
          <div className="truncate text-xs text-text">{scenario?.name ?? 'No scenario loaded'}</div>
        </div>
        <ThreatBadge state={simulation?.overall_threat_state} large />
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-dim">
        <span className="mono">{formatUtc(sim.currentUnix)}</span>
        <span>research prototype · simulation only</span>
      </div>
    </header>
  );
}

function ConjunctionRow({ c, selected, onSelect }: { c: Conjunction; selected: boolean; onSelect: () => void }) {
  return (
    <button onClick={onSelect} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-panel-2 ${selected ? 'bg-panel-2 ring-1 ring-primary/40' : ''}`}>
      <span className="mono w-5 text-dim">#{c.rank}</span>
      <span className="min-w-0 flex-1 truncate text-text">{c.secondary_name ?? c.secondary_id}</span>
      <span className="mono text-muted">{formatKm(c.miss_distance_km)}</span>
      <span className="mono text-dim">{formatUtc(c.tca, false).slice(0, 8)}</span>
      <ThreatBadge state={c.threat_state} />
    </button>
  );
}

function ThreatSection() {
  const screening = useAppStore((s) => s.screening);
  const loading = useAppStore((s) => s.screeningLoading);
  const error = useAppStore((s) => s.screeningError);
  const conj = useAppStore((s) => s.selectedConjunction());
  const selectConjunction = useAppStore((s) => s.selectConjunction);
  const scenario = useAppStore((s) => s.scenario);
  const loadScenario = useAppStore((s) => s.loadScenario);
  const runScreening = useAppStore((s) => s.runScreening);
  const sim = useSimulation();
  const stats = screening?.stats as Record<string, unknown> | undefined;

  if (error) return <Section title="Active threat"><ErrorText>Screening failed: {error}</ErrorText></Section>;
  if (loading) {
    return (
      <Section title="Active threat">
        <div className="flex items-center gap-2 text-[11px] text-muted"><Spinner /> Propagating catalog and refining close approaches…</div>
      </Section>
    );
  }
  if (!screening) {
    return (
      <Section title="Active threat">
        <Empty>No screening has been run for this scenario. Use <span className="text-text">Screen conjunctions</span> or <span className="text-text">Analyze with agent</span>.</Empty>
      </Section>
    );
  }
  if (screening.conjunctions.length === 0) {
    return (
      <Section title="Active threat">
        <Empty>
          No close approach inside {String(stats?.screening_radius_km ?? '')} km during the window ({stats?.candidates_after_altitude_filter as number} candidates screened). The state is NORMAL.
          {scenario?.kind === 'real' && (
            <div className="mt-2">
              <Button size="sm" onClick={() => void loadScenario('synthetic-conjunction')}>Switch to the synthetic scenario</Button>
            </div>
          )}
        </Empty>
      </Section>
    );
  }
  const c = conj ?? screening.conjunctions[0];
  const pc = c.pc;
  const tToTca = c.tca_unix - sim.currentUnix;
  return (
    <Section title="Active threat" right={<ThreatBadge state={c.threat_state} />}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Stat label="Object" value={c.secondary_name ?? c.secondary_id} sub={`${c.secondary_id} · ${c.secondary_category ?? 'unknown'}`} mono={false} className="col-span-2" />
        <Stat label="Closest approach (UTC)" value={formatUtc(c.tca, false)} sub={formatUtc(c.tca).slice(0, 10)} />
        <Stat label="Time to TCA" value={formatCountdown(tToTca)} sub={tToTca < 0 ? 'passed in simulation' : 'at simulation time'} />
        <Stat label="Predicted miss distance" value={formatKm(c.miss_distance_km, 3)} sub={`coarse sample ${formatKm(c.coarse_min_distance_km)} → refined`} />
        <Stat label="Relative speed" value={`${c.relative_speed_kms.toFixed(2)} km/s`} sub="TEME frame" />
        <Stat
          label="Collision probability"
          value={pc?.status === 'COMPUTED' ? formatPc(pc.value) : 'UNVERIFIED'}
          sub={pc?.status === 'COMPUTED' ? `${pc.covariance_basis === 'PROVIDED' ? 'provided covariance' : 'illustrative covariance'} · HBR ${pc.hard_body_radius_m} m` : 'no covariance for public elements'}
          className="col-span-2"
        />
      </div>
      <ul className="mt-2 space-y-0.5 text-[10px] text-muted">
        {c.threat_rationale.map((r) => <li key={r}>• {r}</li>)}
        {pc?.status === 'UNVERIFIED' && pc.reason && <li className="text-accent">• {pc.reason}</li>}
      </ul>
      <div className="mt-2 space-y-1">
        {pc?.status === 'COMPUTED' && (
          <Details summary="Probability method & assumptions">
            <KeyValue rows={[['Method', pc.method], ['Hard-body radius', pc.hard_body_radius_basis], ['σ major / minor', `${(pc.encounter_plane as { sigma_major_m?: number }).sigma_major_m?.toFixed(0)} / ${(pc.encounter_plane as { sigma_minor_m?: number }).sigma_minor_m?.toFixed(0)} m`]]} />
            <ul className="mt-1 text-[10px] text-dim">{pc.assumptions.map((a) => <li key={a}>• {a}</li>)}</ul>
          </Details>
        )}
        <Details summary="Propagation quality & limitations">
          <KeyValue rows={[['Primary model', c.primary_model], ['Secondary model', c.secondary_model], ['Primary epoch', formatUtc(c.primary_epoch)], ['Secondary epoch', formatUtc(c.secondary_epoch)], ['Refinement', `${(c.refinement as { function_evaluations?: number }).function_evaluations} evaluations, ${(c.refinement as { tolerance_s?: number }).tolerance_s} s tolerance`]]} />
          <ul className="mt-1 text-[10px] text-dim">
            {c.quality.warnings.map((w) => <li key={w} className="text-warn">• {w}</li>)}
            {c.quality.limitations.map((l) => <li key={l}>• {l}</li>)}
          </ul>
        </Details>
        <Details summary={`All ${screening.conjunctions.length} conjunctions inside ${String(stats?.screening_radius_km)} km (${formatDuration(Number(stats?.duration_s ?? 0))} screening)`}>
          <div className="max-h-44 space-y-0.5 overflow-y-auto scrollbar-thin">
            {screening.conjunctions.map((x) => <ConjunctionRow key={x.conjunction_id} c={x} selected={x.conjunction_id === c.conjunction_id} onSelect={() => selectConjunction(x.conjunction_id)} />)}
          </div>
          {screening.co_orbital.length > 0 && <div className="mt-1 text-[10px] text-dim">Excluded as co-orbital/docked: {screening.co_orbital.map((x) => x.name.trim()).join(', ')}</div>}
          <div className="mt-1 text-[10px] text-dim">{String(stats?.candidates_after_altitude_filter)} of {String(stats?.objects_total)} objects passed the altitude-band filter · coarse step {String(stats?.coarse_step_s)} s · {screening.stats.complete ? 'complete' : 'incomplete (propagation failures)'}</div>
          {scenario?.kind === 'real' && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => void runScreening('illustrative_default')} title="Compute Pc with documented placeholder covariances (labelled illustrative)">
                Re-screen with illustrative covariance
              </Button>
            </div>
          )}
        </Details>
      </div>
    </Section>
  );
}

function AgentSection() {
  const run = useAppStore((s) => s.agentRun);
  const loading = useAppStore((s) => s.agentLoading);
  const error = useAppStore((s) => s.agentError);
  const runAgent = useAppStore((s) => s.runAgent);
  const scenario = useAppStore((s) => s.scenario);
  const health = useAppStore((s) => s.health);
  return (
    <Section
      title="AI agent"
      right={
        <Button variant="primary" size="sm" loading={loading} disabled={!scenario} onClick={() => void runAgent()}>
          {loading ? 'Running tools…' : run ? 'Re-analyze' : 'Analyze with agent'}
        </Button>
      }
    >
      {error && <ErrorText>{error}</ErrorText>}
      {!run && !loading && !error && (
        <Empty>
          The agent screens, plans, checks secondary risks and explains a recommendation. Every number it reports comes from a backend tool result.
          {health && !health.gemini_configured && <div className="mt-1 text-dim">No GEMINI_API_KEY configured: the deterministic fallback runs the same tool workflow with a templated explanation.</div>}
        </Empty>
      )}
      {loading && <div className="text-[11px] text-muted">Screening → details → planning → secondary checks → report. This takes a few seconds.</div>}
      {run && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="info">{run.provider === 'gemini' ? `Gemini · ${run.model}` : 'deterministic fallback'}</Badge>
            <Badge tone={run.status === 'NEEDS_APPROVAL' ? 'safe' : run.status === 'COMPLETED' ? 'neutral' : 'threat'}>{run.status.replace('_', ' ')}</Badge>
            <Badge tone={run.validation.status === 'VALID' ? 'safe' : 'threat'}>validation {run.validation.status}</Badge>
            <span className="mono text-[10px] text-dim">{run.run_id}</span>
          </div>
          {run.warnings.length > 0 && <div className="text-[10px] text-warn">{run.warnings.join(' · ')}</div>}
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-text">{run.narrative}</p>
          <Details summary={`Validation checks (${run.validation.checks.filter((c) => c.ok).length}/${run.validation.checks.length} passed)`}>
            <ul className="space-y-0.5 text-[10px]">
              {run.validation.checks.map((c) => (
                <li key={c.check} className={c.ok ? 'text-muted' : 'text-threat'}>
                  {c.ok ? '✓' : '✗'} {c.check} — {c.detail}
                </li>
              ))}
            </ul>
          </Details>
          <Details summary={`Tool execution history (${run.tool_calls.length} calls)`} open>
            <ol className="space-y-1">
              {run.tool_calls.map((t) => (
                <li key={t.step} className="rounded border border-line bg-panel-2/60 px-2 py-1 text-[10px]">
                  <div className="flex items-center gap-2">
                    <span className="mono text-dim">{t.step}</span>
                    <span className="mono text-text">{t.tool}</span>
                    <Badge tone={t.status === 'OK' ? 'safe' : 'threat'}>{t.status}</Badge>
                    <span className="ml-auto mono text-dim">{t.duration_ms.toFixed(0)} ms</span>
                  </div>
                  {Object.keys(t.arguments).length > 0 && <div className="mono truncate text-dim">args {JSON.stringify(t.arguments)}</div>}
                  <div className="text-muted">{t.error ?? t.summary}</div>
                </li>
              ))}
            </ol>
          </Details>
        </div>
      )}
    </Section>
  );
}

function ManeuverRow({ m, selected, approved, onSelect }: { m: Maneuver; selected: boolean; approved: boolean; onSelect: () => void }) {
  const sc = m.secondary_check;
  return (
    <tr onClick={onSelect} className={`cursor-pointer border-t border-line text-[10px] hover:bg-panel-2 ${selected ? 'bg-panel-2' : ''}`}>
      <td className="whitespace-nowrap px-1 py-1" title={m.maneuver_id}>
        <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${approved ? 'bg-safe-strong' : selected ? 'bg-safe' : 'bg-safe/40'}`} />
        <span className="mono text-text">{m.maneuver_id.split('-').slice(-1)[0]}</span>
      </td>
      <td className="mono whitespace-nowrap px-1 py-1 text-muted">{m.direction} · {m.lead_orbits}P</td>
      <td className="mono px-1 py-1 text-text">{m.dv_magnitude_mps.toFixed(2)}</td>
      <td className="mono whitespace-nowrap px-1 py-1 text-text">{formatKm(m.post_miss_distance_km)}</td>
      <td className="mono px-1 py-1 text-muted">{pcLabel(m.post_pc)}</td>
      <td className="px-1 py-1">{m.meets_target ? <span className="text-safe">✓</span> : <span className="text-threat">✗</span>}</td>
      <td className="px-1 py-1">{sc ? <Badge tone={sc.validation_status === 'PASS' ? 'safe' : sc.validation_status === 'LIMITED' ? 'warn' : 'threat'}>{sc.validation_status}</Badge> : <span className="text-dim">—</span>}</td>
    </tr>
  );
}

function CandidatesSection() {
  const plan = useAppStore((s) => s.plan);
  const loading = useAppStore((s) => s.planLoading);
  const error = useAppStore((s) => s.planError);
  const planManeuvers = useAppStore((s) => s.planManeuvers);
  const conj = useAppStore((s) => s.selectedConjunction());
  const selectedId = useAppStore((s) => s.selectedManeuverId);
  const selectManeuver = useAppStore((s) => s.selectManeuver);
  const approvedId = useAppStore((s) => s.simulation?.approved_maneuver_id ?? null);
  const secondaryLoading = useAppStore((s) => s.secondaryLoading);
  const scenario = useAppStore((s) => s.scenario);
  const [showAll, setShowAll] = useState(false);
  const targetKm = Number((scenario?.thresholds as { miss_distance_target_km?: number })?.miss_distance_target_km ?? 5);

  const right = (
    <Button size="sm" loading={loading} disabled={!conj} onClick={() => void planManeuvers()}>
      {plan ? 'Re-plan' : 'Plan maneuvers'}
    </Button>
  );
  if (error) return <Section title="Candidate maneuvers" right={right}><ErrorText>{error}</ErrorText></Section>;
  if (loading) return <Section title="Candidate maneuvers"><div className="flex items-center gap-2 text-[11px] text-muted"><Spinner /> Evaluating the burn grid with the two-body + J2 model…</div></Section>;
  if (!plan) {
    return (
      <Section title="Candidate maneuvers" right={right}>
        <Empty>{conj ? 'No plan yet. Plan maneuvers for the active threat or let the agent do it.' : 'Select a threat first.'}</Empty>
      </Section>
    );
  }
  const shown = plan.candidates.filter((c) => plan.recommended_ids.includes(c.maneuver_id) || c.maneuver_id === approvedId);
  const all = [...plan.candidates].sort((a, b) => a.objective_score - b.objective_score).slice(0, 25);
  const baseline = conj?.conjunction_id === plan.conjunction_id ? conj.miss_distance_km : shown[0]?.screening_miss_distance_km ?? 0;
  return (
    <Section title="Candidate maneuvers" right={right}>
      <div className="mb-1 text-[10px] text-muted">
        {plan.stats.candidates_evaluated} candidates evaluated in {plan.stats.duration_s.toFixed(1)} s · {plan.stats.meeting_target} meet the target · {plan.stats.valid} feasible
        {secondaryLoading && <span className="ml-1 text-dim">· checking secondary risks for {secondaryLoading}…</span>}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[9px] uppercase tracking-wider text-dim">
            <th className="px-1 py-1 font-medium">ID</th>
            <th className="px-1 py-1 font-medium">Burn</th>
            <th className="px-1 py-1 font-medium">Δv m/s</th>
            <th className="px-1 py-1 font-medium">Miss</th>
            <th className="px-1 py-1 font-medium">Post Pc</th>
            <th className="px-1 py-1 font-medium">Target</th>
            <th className="px-1 py-1 font-medium">2nd scr.</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => <ManeuverRow key={m.maneuver_id} m={m} selected={m.maneuver_id === selectedId} approved={m.maneuver_id === approvedId} onSelect={() => selectManeuver(m.maneuver_id)} />)}
        </tbody>
      </table>
      <CandidateChart candidates={shown} baselineMissKm={baseline} selectedId={selectedId} approvedId={approvedId} targetKm={targetKm} onSelect={selectManeuver} />
      <div className="mt-2 space-y-1">
        <Details summary="Objective, assumptions & model consistency">
          <p className="text-[10px] text-muted">{plan.objective}</p>
          <ul className="mt-1 text-[10px] text-dim">{plan.assumptions.map((a) => <li key={a}>• {a}</li>)}</ul>
          <ul className="mt-1 text-[10px] text-dim">
            {plan.baseline.map((b, i) => (
              <li key={i}>• lead {String(b.lead_orbits)} orbits: numerical zero-Δv miss {formatKm(b.numerical_zero_dv_miss_km as number, 3)} vs screening {formatKm(b.screening_miss_km as number, 3)} (model difference {((b.model_difference_km as number) ?? 0).toFixed(3)} km)</li>
            ))}
          </ul>
        </Details>
        <Details summary={showAll ? 'Hide evaluated candidates' : `Show top ${all.length} evaluated candidates by score`}>
          <div className="max-h-48 overflow-y-auto scrollbar-thin" onClick={() => setShowAll(true)}>
            <table className="w-full">
              <tbody>
                {all.map((m) => <ManeuverRow key={m.maneuver_id} m={m} selected={m.maneuver_id === selectedId} approved={m.maneuver_id === approvedId} onSelect={() => selectManeuver(m.maneuver_id)} />)}
              </tbody>
            </table>
          </div>
        </Details>
      </div>
    </Section>
  );
}

function DecisionSection() {
  const m = useAppStore((s) => s.selectedManeuver());
  const simulation = useAppStore((s) => s.simulation);
  const approve = useAppStore((s) => s.approve);
  const reject = useAppStore((s) => s.reject);
  const loading = useAppStore((s) => s.decisionLoading);
  const error = useAppStore((s) => s.decisionError);
  const checks = useAppStore((s) => s.secondaryChecks);
  const runSecondaryCheck = useAppStore((s) => s.runSecondaryCheck);
  const secondaryLoading = useAppStore((s) => s.secondaryLoading);
  const approvedId = simulation?.approved_maneuver_id ?? null;
  const post = simulation?.post_approval ?? null;
  const check = m ? checks[m.maneuver_id] : undefined;
  const canApprove = !!m && m.feasible && m.secondary_check?.validation_status !== 'FAIL' && approvedId !== m.maneuver_id && !loading;
  return (
    <Section title="Human decision">
      {!m && <Empty>Select a candidate maneuver to approve or reject it. Approval only updates the simulation.</Empty>}
      {m && (
        <div className="space-y-2">
          <KeyValue
            rows={[
              ['Maneuver', m.maneuver_id],
              ['Burn', `${formatUtc(m.burn_time, false)} · ${m.direction_label}`],
              ['Δv', `${m.dv_magnitude_mps.toFixed(2)} m/s (${(m.fuel_proxy.fraction_of_budget * 100).toFixed(0)}% of budget proxy)`],
              ['Post-burn miss', `${formatKm(m.post_miss_distance_km, 3)} at ${formatUtc(m.post_tca, false)}`],
              ['Post-burn Pc', pcLabel(m.post_pc)],
              ['Target', `${m.meets_target ? 'met' : 'NOT met'} — ${m.target_basis}`],
              ['Secondary screening', m.secondary_check ? `${m.secondary_check.validation_status} · ${m.secondary_check.new_conjunctions} new conjunction(s) · worst new ${m.secondary_check.worst_new_state}` : 'not run'],
            ]}
          />
          {!m.feasible && <div className="text-[10px] text-threat">Rejected by the planner: {m.feasibility_reasons.join('; ')}</div>}
          {check && (
            <Details summary="Secondary screening details">
              <ul className="text-[10px] text-dim">
                {check.limitations.map((l) => <li key={l}>• {l}</li>)}
                {check.changed_conjunctions.slice(0, 6).map((x) => (
                  <li key={x.conjunction_id}>• {x.secondary_id}: {formatKm(x.before_miss_km)} → {x.after_miss_km === null ? `cleared (${x.status.toLowerCase().replace(/_/g, ' ')})` : formatKm(x.after_miss_km)} ({x.after_state})</li>
                ))}
                {check.new_conjunctions.map((x) => <li key={x.conjunction_id} className="text-warn">• NEW {x.secondary_name ?? x.secondary_id}: {formatKm(x.miss_distance_km)} at {formatUtc(x.tca, false)} ({x.threat_state})</li>)}
              </ul>
            </Details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="safe" disabled={!canApprove} loading={loading} onClick={() => void approve(m.maneuver_id)} title="Simulation action: switches the displayed trajectory to the post-burn prediction">
              Approve simulated maneuver
            </Button>
            <Button variant="danger" disabled={loading} onClick={() => void reject(m.maneuver_id, 'Rejected by operator')}>
              Reject maneuver
            </Button>
            {!m.secondary_check && (
              <Button variant="ghost" size="sm" loading={secondaryLoading === m.maneuver_id} onClick={() => void runSecondaryCheck(m.maneuver_id)}>
                Run secondary screening
              </Button>
            )}
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {approvedId === m.maneuver_id && post && (
            <div className="rounded border border-safe/40 bg-safe/10 px-2 py-2 text-[11px] text-safe">
              <div className="font-semibold">Approved in simulation · state {post.overall_threat_state}</div>
              <div className="text-[10px] text-text/80">
                Post-burn miss {formatKm(post.post_miss_distance_km, 3)} at {formatUtc(post.post_tca, false)} · Pc {pcLabel(post.post_pc)} · secondary screening {post.secondary_check_status}. The original trajectory stays visible (dashed cyan) for comparison.
              </div>
              <div className="mt-1 text-[10px] text-dim">No command is sent to any spacecraft.</div>
            </div>
          )}
        </div>
      )}
      {simulation && simulation.decisions.length > 0 && (
        <Details summary={`Decision log (${simulation.decisions.length})`}>
          <ul className="space-y-0.5 text-[10px] text-muted">
            {simulation.decisions.slice().reverse().map((d) => (
              <li key={d.decision_id}>
                <span className="mono text-dim">{formatUtc(d.at, false)}</span> <span className={d.type === 'APPROVED' ? 'text-safe' : 'text-threat'}>{d.type}</span> <span className="mono">{d.maneuver_id}</span>
                {d.reason ? ` — ${d.reason}` : ''}
              </li>
            ))}
          </ul>
        </Details>
      )}
    </Section>
  );
}

export default function MissionPanel() {
  const scenario = useAppStore((s) => s.scenario);
  return (
    <aside className="flex h-full w-full flex-col bg-panel/95 backdrop-blur lg:border-l lg:border-line" aria-label="Mission intelligence panel">
      <PanelHeader />
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <ThreatSection />
        <AgentSection />
        <CandidatesSection />
        <DecisionSection />
        {scenario && (
          <div className="px-4 py-3 text-[10px] leading-relaxed text-dim">
            {scenario.disclaimers.map((d) => <p key={d}>{d}</p>)}
          </div>
        )}
      </div>
    </aside>
  );
}
