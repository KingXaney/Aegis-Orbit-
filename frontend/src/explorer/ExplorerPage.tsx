import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/barlow-condensed/600.css';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api/client';
import Approaches from './Approaches';
import DetailsCard from './DetailsCard';
import FilterPanel from './FilterPanel';
import FindBox from './FindBox';
import GlobeBoundary from './GlobeBoundary';
import { OBJECT_TYPES, activeFilterCount } from './filters';
import { CriticalMark, DetectedMark, FiltersIcon } from './icons';
import { TYPE_INK } from './palette';
import { useExplorerStore } from './store';

// Cesium is most of the page's weight; loading it separately lets the text paint first.
const GlobeCanvas = lazy(() => import('./GlobeCanvas'));

const nf = new Intl.NumberFormat('en-US');
const retrievedFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

const TYPE_PLURAL = { PAYLOAD: 'Active satellites', DEBRIS: 'Debris', ROCKET_BODY: 'Rocket bodies' } as const;

function SiteHeader() {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4">
      <a href="/" aria-current="page" className="x-display x-focus inline-flex min-h-10 items-center rounded-[4px] text-x-21">
        Aegis Orbit
      </a>
    </div>
  );
}

function UtcClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <p className="pointer-events-none absolute left-4 top-4 rounded-[4px] bg-x-bg px-2 py-1 text-x-12 text-x-muted">
      Positions at <span className="text-x-text">{clockFormat.format(now)}</span> UTC
    </p>
  );
}

/** The globe's colour key, on the globe. */
function GlobeKey() {
  const highlight = useExplorerStore((s) => s.highlightDetections);
  const critical = useExplorerStore((s) => s.approaches.data?.critical_distance_km ?? null);
  const items: [string, string][] = [
    ['var(--x-accent)', 'GPM and its orbit'],
    [TYPE_INK.PAYLOAD, 'Active satellites'],
    [TYPE_INK.DEBRIS, 'Debris'],
    [TYPE_INK.ROCKET_BODY, 'Rocket bodies'],
  ];
  return (
    <ul className="pointer-events-none absolute bottom-4 left-4 flex flex-wrap gap-x-4 gap-y-1 rounded-[4px] bg-x-bg px-2 py-1 text-x-12 text-x-muted max-lg:right-4" aria-label="Colour key">
      {items.map(([ink, label]) => (
        <li key={label} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: ink }} aria-hidden="true" />
          {label}
        </li>
      ))}
      {highlight && critical !== null && (
        <>
          <li className="flex items-center gap-2">
            <DetectedMark />
            Passes near GPM
          </li>
          <li className="flex items-center gap-2 text-x-warning">
            <CriticalMark />
            Critical, under {critical} km
          </li>
        </>
      )}
    </ul>
  );
}

/** Steps the rest of the catalog back so GPM's detections read as the population around its orbit. */
function HighlightSwitch() {
  const on = useExplorerStore((s) => s.highlightDetections);
  const setOn = useExplorerStore((s) => s.setHighlightDetections);
  return (
    <label className="x-row -mx-2 mt-2">
      <input type="checkbox" role="switch" className="peer sr-only" checked={on} onChange={() => setOn(!on)} />
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-[background-color,border-color] duration-150 ${on ? 'border-x-text bg-x-text' : 'border-x-control'}`}
        aria-hidden="true"
      >
        <span className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full transition-[transform,background-color] duration-150 ease-[var(--x-ease)] ${on ? 'translate-x-4 bg-x-bg' : 'bg-x-muted'}`} />
      </span>
      <span className="flex-1 text-x-14">Highlight what GPM will pass</span>
    </label>
  );
}

function FiltersButton({ buttonRef }: { buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  const open = useExplorerStore((s) => s.panelOpen);
  const setOpen = useExplorerStore((s) => s.setPanelOpen);
  const active = useExplorerStore((s) => activeFilterCount(s.filters));
  const ready = useExplorerStore((s) => s.status === 'ready');
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-controls="filter-panel"
      aria-label={active ? `Filters, ${active} applied` : 'Filters'}
      onClick={() => setOpen(!open)}
      disabled={!ready}
      className="x-button shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <FiltersIcon />
      Filters
      {active > 0 && <span className="x-mono rounded-[4px] bg-x-accent px-1.5 text-x-12 font-bold text-x-bg">{active}</span>}
    </button>
  );
}

/** What the globe shows, by type. Doubles as its colour key. */
function CatalogKey({ filtersButton }: { filtersButton: React.RefObject<HTMLButtonElement | null> }) {
  const ready = useExplorerStore((s) => s.status === 'ready');
  const byType = useExplorerStore((s) => s.visibleByType);
  const visible = useExplorerStore((s) => s.visible);
  const active = useExplorerStore((s) => activeFilterCount(s.filters));
  const resetFilters = useExplorerStore((s) => s.resetFilters);
  return (
    <section aria-labelledby="catalog-heading" className="border-t border-x-divider pt-6 md:border-t-0 md:pt-0 lg:border-t lg:pt-6">
      <div className="flex items-center justify-between gap-4">
        <h2 id="catalog-heading" className="x-display text-x-21">
          On the globe
        </h2>
        <FiltersButton buttonRef={filtersButton} />
      </div>
      <div className="mt-4">
        <FindBox />
      </div>
      <HighlightSwitch />
      <ul className="mt-4" aria-label="Objects shown, by type">
        {OBJECT_TYPES.map((t) => (
          <li key={t} className="flex min-h-8 items-center gap-3">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_INK[t] }} aria-hidden="true" />
            <span className="flex-1 text-x-14">{TYPE_PLURAL[t]}</span>
            {ready ? <span className="text-x-14">{nf.format(byType[t])}</span> : <span className="x-skeleton h-3 w-14" aria-hidden="true" />}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-x-14 text-x-muted" aria-live="polite">
        {!ready ? (
          'Fetching orbital elements…'
        ) : active > 0 ? (
          <>
            {nf.format(visible)} shown with filters.{' '}
            <button type="button" onClick={resetFilters} className="x-link">
              Show everything
            </button>
          </>
        ) : (
          `${nf.format(visible)} objects, each positioned live in your browser.`
        )}
      </p>
    </section>
  );
}

/** What the globe is doing while it has nothing (or nothing matching) to show. */
function GlobeStatus() {
  const status = useExplorerStore((s) => s.status);
  const propagated = useExplorerStore((s) => s.propagated);
  const sceneError = useExplorerStore((s) => s.sceneError);
  const total = useExplorerStore((s) => s.objects.length);
  const visible = useExplorerStore((s) => s.visible);
  const resetFilters = useExplorerStore((s) => s.resetFilters);
  let body: React.ReactNode = null;
  if (sceneError) {
    body = 'The 3D globe needs WebGL, which this browser can’t provide right now. Everything beside it still works.';
  } else if (status === 'loading') {
    body = 'Fetching orbital elements…';
  } else if (status === 'error') {
    body = 'The catalog didn’t load, so there is nothing to show yet.';
  } else if (!propagated) {
    body = `Propagating ${nf.format(total)} objects with SGP4…`;
  } else if (visible === 0) {
    body = (
      <>
        No objects match these filters.{' '}
        <button type="button" onClick={resetFilters} className="x-link pointer-events-auto">
          Reset filters
        </button>
      </>
    );
  }
  if (!body) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <p className="x-fade-in max-w-[320px] rounded-[8px] bg-x-bg px-3 py-2 text-center text-x-14 text-x-muted" role={sceneError ? 'alert' : 'status'}>
        {body}
      </p>
    </div>
  );
}

function DataCredit() {
  const meta = useExplorerStore((s) => s.meta);
  const retrieved = meta?.retrieved_at ? retrievedFormat.format(new Date(meta.retrieved_at)) : null;
  return (
    <p className="text-x-12 text-x-muted md:col-span-2">
      Orbital elements from{' '}
      <a href="https://celestrak.org" className="x-link" rel="noopener">
        CelesTrak
      </a>{' '}
      GP data and SATCAT{retrieved ? `, retrieved ${retrieved} UTC` : ''}. Positions are SGP4 estimates, not telemetry.
    </p>
  );
}

export default function ExplorerPage() {
  const status = useExplorerStore((s) => s.status);
  const error = useExplorerStore((s) => s.error);
  const sceneError = useExplorerStore((s) => s.sceneError);
  const panelOpen = useExplorerStore((s) => s.panelOpen);
  const load = useExplorerStore((s) => s.load);
  const loadApproaches = useExplorerStore((s) => s.loadApproaches);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // The catalog and GPM's screening load side by side; the screening may take a while on a cold backend.
  useEffect(() => {
    void load();
    void loadApproaches();
  }, [load, loadApproaches]);

  // The browser chrome matches the page on phones.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = getComputedStyle(document.documentElement).getPropertyValue('--x-bg').trim() || '#0b0d10';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  // Return focus to the Filters button when the filters sheet closes.
  useEffect(() => {
    if (wasOpen.current && !panelOpen) filtersButton.current?.focus();
    wasOpen.current = panelOpen;
  }, [panelOpen]);

  return (
    <main className="explorer grid min-h-full bg-x-bg font-x-body text-x-text [grid-template-areas:'head'_'globe'_'body'] [grid-template-rows:auto_56svh_auto] lg:h-full lg:grid-cols-[minmax(360px,420px)_1fr] lg:[grid-template-areas:'head_globe'_'body_globe'] lg:[grid-template-rows:auto_1fr]">
      <header inert={panelOpen} className="px-4 pb-6 pt-4 [grid-area:head] md:px-6 lg:border-r lg:border-x-divider lg:pt-6">
        <SiteHeader />
        <h1 className="x-display mt-8 text-x-28 lg:mt-10 2xl:text-x-36">Aegis Orbit predicts close approaches in orbit and plans the burn that avoids them.</h1>
        <p className="mt-4 text-x-16 text-x-muted">It screens a spacecraft against the public catalog, states the uncertainty in every number, and waits for a person to approve the burn.</p>
        <a href="/mission" className="x-button x-button-primary mt-6 w-full sm:w-auto">
          Simulate Collision
        </a>
        <p className="mt-2 text-x-12 text-x-muted">Opens the simulator on a scripted encounter with a GPM stand-in.</p>
      </header>

      <section inert={panelOpen} id="globe" aria-label="Live globe of tracked objects" className="relative min-h-[320px] scroll-mt-4 overflow-hidden [grid-area:globe]">
        <GlobeBoundary>
          <Suspense fallback={null}>
            <GlobeCanvas />
          </Suspense>
        </GlobeBoundary>
        <UtcClock />
        {status === 'ready' && !sceneError && <GlobeKey />}
        <GlobeStatus />
        {status === 'ready' && <DetailsCard />}
      </section>

      <div inert={panelOpen} className="x-scroll flex flex-col gap-8 px-4 py-8 [grid-area:body] md:grid md:grid-cols-2 md:items-start md:gap-x-8 md:px-6 lg:flex lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-x-divider lg:pt-0">
        {status === 'error' && (
          <div className="x-panel p-4 md:col-span-2" role="alert">
            <h2 className="text-x-16 font-bold">Can’t load the catalog from {API_BASE}</h2>
            <p className="mt-2 text-x-14 text-x-muted">{error}</p>
            <p className="mt-2 text-x-14 text-x-muted">
              Start the backend with <code className="x-mono text-x-text">uvicorn app.main:app --reload</code> in <code className="x-mono text-x-text">backend/</code>, then retry.
            </p>
            <button type="button" onClick={() => void load()} className="x-button mt-4">
              Retry
            </button>
          </div>
        )}
        <Approaches />
        {status !== 'error' && <CatalogKey filtersButton={filtersButton} />}
        <DataCredit />
      </div>

      {status === 'ready' && <FilterPanel />}
    </main>
  );
}
