import { useEffect, type ReactNode } from 'react';
import { MODEL_NORAD_ID, ORBIT_CLASS_LABEL, TYPE_LABEL } from './filters';
import { CloseIcon } from './icons';
import { ownerName } from './owners';
import { TYPE_INK } from './palette';
import { useExplorerStore } from './store';

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatDate(iso: string | null): string {
  if (!iso) return 'Not recorded';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

function formatPeriod(min: number): string {
  if (min < 180) return `${min.toFixed(1)} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${Math.round(min - h * 60)} min`;
}

function Row({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-x-14 text-x-muted">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className="x-mono text-x-14">{children}</span>
        {sub && <span className="block text-x-12 text-x-muted">{sub}</span>}
      </dd>
    </div>
  );
}

/** Holds the width of a live value until the first propagated state arrives. */
function Pending({ width }: { width: string }) {
  return <span className="x-skeleton inline-block h-3 align-middle" style={{ width }} aria-label="Computing" />;
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
      className="x-panel x-floating x-card-in fixed inset-x-0 bottom-0 z-30 max-h-[70svh] overflow-y-auto rounded-b-none p-4 lg:absolute lg:inset-x-auto lg:bottom-auto lg:right-4 lg:top-4 lg:max-h-[calc(100%-2rem)] lg:w-[340px] lg:rounded-b-[12px]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 pt-1">
          <p className="flex items-center gap-2 text-x-12" style={{ color: TYPE_INK[o.type] }}>
            <span className="h-2 w-2 rounded-full" style={{ background: o.norad_id === MODEL_NORAD_ID ? 'var(--x-accent)' : TYPE_INK[o.type] }} aria-hidden="true" />
            {TYPE_LABEL[o.type]}
          </p>
          <h2 className="x-display mt-1 break-words text-x-28">{o.name}</h2>
        </div>
        <button type="button" onClick={() => select(null)} className="x-button -mr-1 -mt-1 border-transparent bg-transparent px-0" aria-label="Close details">
          <CloseIcon />
        </button>
      </div>

      {o.norad_id === MODEL_NORAD_ID && (
        <p className="mt-3 border-l-2 border-x-accent pl-3 text-x-14 text-x-muted">
          The spacecraft the simulator flies. Its scripted scenario uses a stand-in on this orbit.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
        <Row label="NORAD ID">{o.norad_id}</Row>
        <Row label="Operator">
          <span className="font-x-body">{ownerName(o.owner)}</span>
        </Row>
        <Row label="Launched">{formatDate(o.launch_date)}</Row>
        <Row label="Altitude" sub={elliptical ? `Perigee ${nf0.format(o.perigee_km)} km, apogee ${nf0.format(o.apogee_km)} km` : undefined}>
          {live ? `${nf0.format(live.altitudeKm)} km` : <Pending width="56px" />}
        </Row>
        <Row label="Speed">{live ? `${live.speedKms.toFixed(2)} km/s` : <Pending width="72px" />}</Row>
        <Row label="Inclination">{o.inclination_deg.toFixed(2)}°</Row>
        <Row label="Orbital period">{formatPeriod(o.period_min)}</Row>
        <Row label="Orbit class" sub={ORBIT_CLASS_LABEL[o.orbit_class]}>{o.orbit_class}</Row>
      </dl>

      <p className="mt-4 border-t border-x-divider pt-3 text-x-12 text-x-muted">
        Elements dated {formatDate(o.epoch)}. Altitude and speed are SGP4 estimates from them, updated every second.
      </p>
    </section>
  );
}
