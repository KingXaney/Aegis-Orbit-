import { useEffect, useState } from 'react';
import type { ApproachRecord } from '../types/api';
import { TYPE_INK } from './palette';
import { revealGlobe } from './reveal';
import { approachKey, useExplorerStore } from './store';

// The signature of the page: what the simulator's screening finds for the real GPM over the next
// 24 hours. Hovering or focusing a pass previews it on the globe (both orbits and where they cross);
// selecting it pins it there and turns the camera to it.

const ROWS = 5;
const nf = new Intl.NumberFormat('en-US');
const tcaFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

const pad = (n: number) => String(n).padStart(2, '0');
const NBSP = '\u00a0';

/** Time to TCA, with non-breaking spaces so a value never wraps. */
export function countdown(s: number): string {
  if (s < 60) return `${Math.max(0, Math.floor(s))}${NBSP}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}${NBSP}h${NBSP}${pad(m)}${NBSP}m` : `${m}${NBSP}m${NBSP}${pad(Math.floor(s % 60))}${NBSP}s`;
}

function spokenCountdown(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
  return m > 0 ? `${m} minute${m === 1 ? '' : 's'}` : 'under a minute';
}

export function km(d: number): string {
  return `${d < 10 ? d.toFixed(2) : d.toFixed(1)}${NBSP}km`;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function useApproachHandlers(a: ApproachRecord) {
  const key = approachKey(a);
  const pinned = useExplorerStore((s) => s.pinnedApproach === key);
  const setPreview = useExplorerStore((s) => s.setPreviewApproach);
  const togglePinned = useExplorerStore((s) => s.togglePinnedApproach);
  const clearPreview = () => {
    if (useExplorerStore.getState().previewApproach === key) setPreview(null);
  };
  return {
    pinned,
    props: {
      'aria-pressed': pinned,
      onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && setPreview(key),
      onPointerLeave: clearPreview,
      onFocus: () => setPreview(key),
      onBlur: clearPreview,
      onClick: () => {
        togglePinned(key);
        if (!pinned) revealGlobe();
      },
    },
  };
}

function ClosestPass({ a, now }: { a: ApproachRecord; now: number }) {
  const { pinned, props } = useApproachHandlers(a);
  const inS = a.tca_unix - now;
  return (
    <button
      type="button"
      {...props}
      aria-label={`Closest pass: ${a.name}, ${km(a.miss_distance_km)}, in ${spokenCountdown(inS)}`}
      className={`x-focus x-press block min-h-[124px] w-full rounded-[12px] border p-4 text-left transition-[background-color,border-color,transform] duration-150 ease-[var(--x-ease)] hover:bg-x-raised ${
        pinned ? 'border-x-accent bg-x-raised' : 'border-x-divider'
      }`}
    >
      <span className="block text-x-12 text-x-muted">Closest pass</span>
      <span className="x-mono mt-1 block text-x-36">{km(a.miss_distance_km)}</span>
      <span className="mt-1 flex items-center gap-2 text-x-14">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_INK[a.type] }} aria-hidden="true" />
        <span className="min-w-0 truncate">{a.name}</span>
        <span className="ml-auto shrink-0 text-x-muted">
          in <span className="x-mono text-x-text">{countdown(inS)}</span>
        </span>
      </span>
    </button>
  );
}

function PassRow({ a, now, closest }: { a: ApproachRecord; now: number; closest: boolean }) {
  const { pinned, props } = useApproachHandlers(a);
  const inS = a.tca_unix - now;
  return (
    <li>
      <button
        type="button"
        {...props}
        aria-label={`${a.name}, ${km(a.miss_distance_km)}, in ${spokenCountdown(inS)}, at ${tcaFormat.format(a.tca_unix * 1000)} UTC`}
        className={`x-focus grid min-h-10 w-full grid-cols-[6.5rem_1fr_auto] items-center gap-3 rounded-[8px] px-2 text-left text-x-14 transition-[background-color] duration-150 ease-[var(--x-ease)] hover:bg-x-raised ${
          pinned ? 'bg-x-raised shadow-[inset_2px_0_0_var(--x-accent)]' : ''
        }`}
      >
        <span className="x-mono text-x-muted">{countdown(inS)}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_INK[a.type] }} aria-hidden="true" />
          <span className="truncate">{a.name}</span>
        </span>
        <span className={`x-mono text-right ${closest ? 'font-bold' : ''}`}>{km(a.miss_distance_km)}</span>
      </button>
    </li>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="min-h-[124px] rounded-[12px] border border-x-divider p-4">
        <span className="x-skeleton block h-3 w-20" />
        <span className="x-skeleton mt-3 block h-8 w-32" />
        <span className="x-skeleton mt-3 block h-3 w-48" />
      </div>
      <ul className="mt-4">
        {Array.from({ length: ROWS }, (_, i) => (
          <li key={i} className="flex min-h-10 items-center gap-3 px-2">
            <span className="x-skeleton h-3 w-16" />
            <span className="x-skeleton h-3 flex-1" />
            <span className="x-skeleton h-3 w-14" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelNow() {
  const live = useExplorerStore((s) => s.modelLive);
  const modelIndex = useExplorerStore((s) => s.modelIndex);
  const hidden = useExplorerStore((s) => s.modelIndex !== null && s.mask.length > 0 && s.mask[s.modelIndex] === 0);
  const focus = useExplorerStore((s) => s.focus);
  const resetFilters = useExplorerStore((s) => s.resetFilters);
  // Live positions come from the globe's worker: nothing to show without the catalog or the globe.
  const unavailable = useExplorerStore((s) => s.status === 'error' || s.sceneError !== null);
  if (unavailable) return null;
  if (hidden) {
    return (
      <p className="mt-2 text-x-14 text-x-muted">
        GPM is hidden by the current filters.{' '}
        <button type="button" className="x-link" onClick={resetFilters}>
          Show everything
        </button>
      </p>
    );
  }
  if (!live) return <span className="x-skeleton mt-2 block h-4 w-full max-w-[320px]" aria-hidden="true" />;
  const lat = `${Math.abs(live.latDeg).toFixed(0)}°${live.latDeg < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(live.lonDeg).toFixed(0)}°${live.lonDeg < 0 ? 'W' : 'E'}`;
  return (
    <p className="mt-2 text-x-14 text-x-muted">
      Right now GPM is <span className="x-mono text-x-text">{live.altitudeKm.toFixed(0)} km</span> up over{' '}
      <span className="x-mono text-x-text">
        {lat} {lon}
      </span>
      , moving at <span className="x-mono text-x-text">{live.speedKms.toFixed(2)} km/s</span>.{' '}
      {modelIndex !== null && (
        <button
          type="button"
          className="x-link"
          onClick={() => {
            focus(modelIndex);
            revealGlobe();
          }}
        >
          Show GPM
        </button>
      )}
    </p>
  );
}

export default function Approaches() {
  const state = useExplorerStore((s) => s.approaches);
  const total = useExplorerStore((s) => s.objects.length);
  const pinnedKey = useExplorerStore((s) => s.pinnedApproach);
  const togglePinned = useExplorerStore((s) => s.togglePinnedApproach);
  const loadApproaches = useExplorerStore((s) => s.loadApproaches);
  const now = useNow();
  const [showAll, setShowAll] = useState(false);

  const upcoming = state.data?.approaches.filter((a) => a.tca_unix > now) ?? [];
  const closest = upcoming.reduce<ApproachRecord | null>((best, a) => (!best || a.miss_distance_km < best.miss_distance_km ? a : best), null);
  const rows = showAll ? upcoming : upcoming.slice(0, ROWS);
  const noneFound = state.data !== null && state.data.approaches.length === 0;
  const exhausted = state.status === 'ready' && upcoming.length === 0 && !noneFound;
  const pinnedGone = pinnedKey !== null && state.data !== null && !upcoming.some((a) => approachKey(a) === pinnedKey);

  // A pinned pass that has gone by unpins itself; Escape puts one away.
  useEffect(() => {
    if (pinnedGone && pinnedKey) togglePinned(pinnedKey);
  }, [pinnedGone, pinnedKey, togglePinned]);

  useEffect(() => {
    if (!pinnedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') togglePinned(pinnedKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedKey, togglePinned]);

  useEffect(() => {
    if (exhausted) void loadApproaches();
  }, [exhausted, loadApproaches]);

  return (
    <section aria-labelledby="approaches-heading" aria-busy={state.status === 'loading' || state.status === 'computing'}>
      <h2 id="approaches-heading" className="x-display text-x-21">
        GPM’s close approaches in the next 24 hours
      </h2>
      <ModelNow />

      <div className="mt-4">
        {(state.status === 'loading' || state.status === 'computing') && (
          <>
            <p className="mb-3 text-x-14 text-x-muted" role="status">
              {total ? `Screening GPM against ${nf.format(total)} catalog objects…` : 'Screening GPM against the catalog…'}
            </p>
            <Skeleton />
          </>
        )}

        {state.status === 'error' && (
          <div role="alert">
            <p className="text-x-14">Couldn’t screen GPM for close approaches.</p>
            <p className="mt-1 text-x-14 text-x-muted">{state.error}</p>
            <button type="button" onClick={() => void loadApproaches()} className="x-button mt-3">
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.data && (
          <>
            {closest ? (
              <>
                <p className="mb-3 text-x-14 text-x-muted">
                  {upcoming.length} pass{upcoming.length === 1 ? '' : 'es'} within {state.data.screening_radius_km} km, found by screening GPM against{' '}
                  {nf.format(state.data.screened)} objects with the simulator’s pipeline.
                </p>
                <ClosestPass a={closest} now={now} />
                <div className="mt-4 grid grid-cols-[6.5rem_1fr_auto] gap-3 px-2 text-x-12 text-x-muted" aria-hidden="true">
                  <span>In</span>
                  <span>Object</span>
                  <span>Miss distance</span>
                </div>
                <ol className="mt-1" aria-label="Passes, soonest first">
                  {rows.map((a) => (
                    <PassRow key={approachKey(a)} a={a} now={now} closest={a === closest} />
                  ))}
                </ol>
                {upcoming.length > ROWS && (
                  <button type="button" onClick={() => setShowAll(!showAll)} className="x-link mt-2 text-x-14">
                    {showAll ? `Show the next ${ROWS}` : `Show all ${upcoming.length} passes`}
                  </button>
                )}
                <p className="mt-3 text-x-12 text-x-muted">Select a pass to see where the two orbits cross. {state.data.note}</p>
              </>
            ) : (
              <p className="text-x-14 text-x-muted" role="status">
                {noneFound
                  ? `Screening found no passes within ${state.data.screening_radius_km} km of GPM in the next 24 hours.`
                  : 'No passes left in this window. Screening the next 24 hours…'}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
