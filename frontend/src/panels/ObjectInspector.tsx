import { useAppStore } from '../store/useAppStore';
import { Badge, Button, KeyValue, Spinner } from '../components/ui';
import { formatNumber, formatUtc } from '../lib/format';

// L in-track, W cross-track, H radial
const DESIGN_BASIS: Record<string, string> = {
  PUBLISHED_SPEC: 'published',
  SCENARIO_DEFINITION: 'scenario definition',
  SIZED_FROM_HARD_BODY_RADIUS: 'generic, sized from HBR',
};

export default function ObjectInspector() {
  const selectedObjectId = useAppStore((s) => s.selectedObjectId);
  const objects = useAppStore((s) => s.objects);
  const detail = useAppStore((s) => s.objectDetail);
  const loading = useAppStore((s) => s.objectDetailLoading);
  const selectObject = useAppStore((s) => s.selectObject);
  const refresh = useAppStore((s) => s.refreshObjectDetail);
  const scenario = useAppStore((s) => s.scenario);
  if (!selectedObjectId) return null;
  const summary = objects[selectedObjectId];
  const name = detail?.name ?? summary?.name ?? selectedObjectId;
  const isPrimary = scenario?.primary_id === selectedObjectId;
  const st = detail?.state;
  const basisLabel = (b: string | undefined) =>
    b === 'PROPAGATED_FROM_GP_ELEMENTS' ? 'propagated from GP elements (SGP4)' : b === 'SYNTHETIC_STATE' ? 'synthetically generated state' : (b ?? '—');

  return (
    <div className="pointer-events-auto w-[320px] rounded border border-line bg-panel/90 backdrop-blur">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-text">{name}</div>
          <div className="mono truncate text-[10px] text-muted">{selectedObjectId}</div>
        </div>
        <div className="flex items-center gap-1">
          {isPrimary && <Badge tone="info">primary</Badge>}
          <Button size="sm" variant="ghost" onClick={() => selectObject(null)} aria-label="Close object details">
            ✕
          </Button>
        </div>
      </header>
      <div className="space-y-3 px-3 py-2 text-[11px]">
        <KeyValue
          rows={[
            ['Category', `${summary?.category ?? detail?.category ?? '—'} (${(summary?.category_basis ?? detail?.category_basis ?? '').toLowerCase().replace(/_/g, ' ')})`],
            ['Source', `${summary?.source ?? '—'} · ${summary?.source_detail ?? ''}`],
            ['Element epoch', formatUtc(summary?.epoch)],
            ['Retrieved', summary?.retrieved_at ? formatUtc(summary.retrieved_at) : 'n/a'],
            ['Position basis', basisLabel(summary?.position_basis)],
            ['Model', summary?.propagation_model ?? '—'],
            ['Perigee / apogee', `${formatNumber(summary?.perigee_alt_km, 0)} / ${formatNumber(summary?.apogee_alt_km, 0)} km`],
            ['Inclination', `${formatNumber(summary?.inclination_deg, 2)}°`],
            ['Design', summary?.design ? `${summary.design.label} (${DESIGN_BASIS[summary.design.basis] ?? summary.design.basis.toLowerCase()})` : '—'],
            ['Size L × W × H', summary?.design ? `${formatNumber(summary.design.length_m, 1)} × ${formatNumber(summary.design.width_m, 1)} × ${formatNumber(summary.design.height_m, 1)} m` : '—'],
            ['Radius (HBR)', `${summary?.radius_m ?? '—'} m (${(summary?.radius_basis ?? '').toLowerCase().replace(/_/g, ' ')})`],
            ['Covariance', summary?.covariance_source === 'UNAVAILABLE' ? 'unavailable' : `${summary?.covariance_source?.toLowerCase().replace(/_/g, ' ')} σ RTN ${summary?.covariance_sigmas_rtn_m?.map((x) => x.toFixed(0)).join(' / ')} m`],
          ]}
        />
        {summary?.warnings?.length ? <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-warn">{summary.warnings.join(' · ')}</div> : null}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-dim">State at {st ? formatUtc(st.at, false) : 'sim time'}</span>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Spinner /> : 'Refresh at sim time'}
            </Button>
          </div>
          {st && st.status === 'OK' ? (
            <KeyValue
              rows={[
                ['Frame / units', `${st.frame} · km, km/s`],
                ['Position', st.position_km.map((x) => x.toFixed(3)).join(', ')],
                ['Velocity', st.velocity_kms.map((x) => x.toFixed(5)).join(', ')],
                ['Altitude (geodetic)', `${formatNumber(st.geodetic.alt_km, 1)} km`],
                ['Lat / lon', `${formatNumber(st.geodetic.lat_deg, 2)}° / ${formatNumber(st.geodetic.lon_deg, 2)}°`],
                ['Osculating a / e', `${formatNumber(st.osculating_elements.a_km, 1)} km / ${formatNumber(st.osculating_elements.e, 4)}`],
              ]}
            />
          ) : loading ? (
            <div className="text-muted">Loading state…</div>
          ) : (
            <div className="text-muted">{st?.messages?.join('; ') || 'State unavailable at this time.'}</div>
          )}
        </div>
      </div>
    </div>
  );
}
