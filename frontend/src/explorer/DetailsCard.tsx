import { useEffect, type ReactNode } from 'react';
import { ORBIT_CLASS_LABEL, TYPE_COLOR, TYPE_LABEL } from './filters';
import { ownerName } from './owners';
import { useExplorerStore } from './store';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatDate(iso: string | null): string {
  if (!iso) return 'Not recorded';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatPeriod(min: number): string {
  if (min < 180) return `${min.toFixed(1)} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${Math.round(min - h * 60)} min`;
}

function Row({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="contents">
      <dt className="pt-px text-[12px] text-x-muted">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className="text-[14px] tabular-nums">{children}</span>
        {sub && <span className="block text-[11px] text-x-muted">{sub}</span>}
      </dd>
    </div>
  );
}

export default function DetailsCard() {
  const selected = useExplorerStore((s) => s.selected);
  const o = useExplorerStore((s) => (s.selected !== null ? s.objects[s.selected] : null));
  const live = useExplorerStore((s) => s.live);
  const select = useExplorerStore((s) => s.select);

  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, select]);

  if (!o) return null;
  const elliptical = o.apogee_km - o.perigee_km > 50;

  return (
    <section
      aria-label={`Details for ${o.name}`}
      className="x-panel x-card-in pointer-events-auto absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-b-none px-5 pb-5 pt-4 md:inset-x-auto md:bottom-auto md:left-5 md:top-16 md:w-[320px] md:rounded-b-[14px]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[12px]" style={{ color: TYPE_COLOR[o.type] }}>
            <span className="h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[o.type], boxShadow: `0 0 8px ${TYPE_COLOR[o.type]}` }} aria-hidden="true" />
            {TYPE_LABEL[o.type]}
          </p>
          <h2 className="mt-1 break-words text-[21px] font-bold leading-[1.15]">{o.name}</h2>
        </div>
        <button type="button" onClick={() => select(null)} className="x-button -mr-1 px-2" aria-label="Close details">
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" /></svg>
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2.5">
        <Row label="NORAD ID">{o.norad_id}</Row>
        <Row label="Operator">
          {ownerName(o.owner)}
        </Row>
        <Row label="Launched">{formatDate(o.launch_date)}</Row>
        <Row label="Altitude" sub={elliptical ? `Perigee ${nf0.format(o.perigee_km)}, apogee ${nf0.format(o.apogee_km)} km` : undefined}>
          {live ? `${nf0.format(live.altitudeKm)} km` : '…'}
        </Row>
        <Row label="Velocity">{live ? `${live.speedKms.toFixed(2)} km/s` : '…'}</Row>
        <Row label="Inclination">{o.inclination_deg.toFixed(2)}°</Row>
        <Row label="Orbital period">{formatPeriod(o.period_min)}</Row>
        <Row label="Orbit class" sub={ORBIT_CLASS_LABEL[o.orbit_class]}>{o.orbit_class}</Row>
      </dl>

      <p className="mt-4 border-t border-x-graticule pt-3 text-[11px] leading-relaxed text-x-muted">
        Elements dated {formatDate(o.epoch)}. Altitude and velocity are SGP4 estimates from them, updated every second.
      </p>
    </section>
  );
}
