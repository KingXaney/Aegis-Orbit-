import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';
import '@fontsource/b612-mono/400.css';
import '@fontsource/barlow-condensed/600.css';
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api/client';
import { formatUtc } from '../lib/format';
import DetailsCard from './DetailsCard';
import FilterPanel from './FilterPanel';
import { OBJECT_TYPES, activeFilterCount } from './filters';
import GlobeCanvas from './GlobeCanvas';
import { FiltersIcon } from './icons';
import { TYPE_INK } from './palette';
import { useExplorerStore } from './store';

const nf = new Intl.NumberFormat('en-US');

const PAGES = [
  { href: '/', label: 'Home' },
  { href: '/mission', label: 'Mission simulator' },
];

const STAT_LABEL = { PAYLOAD: 'Active satellites', DEBRIS: 'Debris', ROCKET_BODY: 'Rocket bodies' } as const;

function SiteNav() {
  const path = window.location.pathname;
  return (
    <nav aria-label="Pages" className="x-panel pointer-events-auto flex gap-0.5 rounded-full p-1">
      {PAGES.map((p) => {
        const current = p.href === '/' ? !path.startsWith('/mission') : path.startsWith(p.href);
        return (
          <a
            key={p.href}
            href={p.href}
            aria-current={current ? 'page' : undefined}
            className={`x-focus rounded-full px-3.5 py-1.5 text-x-12 transition-colors ${current ? 'bg-x-text text-x-bg' : 'text-x-muted hover:text-x-text'}`}
          >
            {p.label}
          </a>
        );
      })}
    </nav>
  );
}

function LiveClock() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <p className="flex items-center gap-2 text-x-12 text-x-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-x-payload" aria-hidden="true" />
      Live
      <span className="tabular-nums text-x-text">{formatUtc(now, false)}</span>
    </p>
  );
}

function FiltersButton({ buttonRef }: { buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  const open = useExplorerStore((s) => s.panelOpen);
  const setOpen = useExplorerStore((s) => s.setPanelOpen);
  const active = useExplorerStore((s) => activeFilterCount(s.filters));
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-controls="filter-panel"
      aria-label={active ? `Filters, ${active} applied` : 'Filters'}
      onClick={() => setOpen(!open)}
      className="x-button pointer-events-auto flex items-center gap-2 rounded-full px-3 py-2 md:px-4"
    >
      <FiltersIcon />
      <span className="hidden text-x-14 md:inline">Filters</span>
      {active > 0 && <span className="rounded-full bg-x-accent px-1.5 text-x-12 font-bold leading-[18px] text-x-bg">{active}</span>}
    </button>
  );
}

/** Counts of what is on screen, by type. Doubles as the colour legend. */
function Stats() {
  const byType = useExplorerStore((s) => s.visibleByType);
  const active = useExplorerStore((s) => activeFilterCount(s.filters));
  const resetFilters = useExplorerStore((s) => s.resetFilters);
  return (
    <div className="x-over-globe flex flex-col items-center gap-3">
      <ul className="flex items-start justify-center gap-6 md:gap-12" aria-label="Objects shown, by type" aria-live="polite">
        {OBJECT_TYPES.map((t) => (
          <li key={t} className="flex flex-col items-center">
            <span className="text-x-21 font-bold tabular-nums leading-none md:text-x-36">{nf.format(byType[t])}</span>
            <span className="mt-2 flex items-center gap-1.5 text-x-12 text-x-muted md:text-x-14">
              <span className="h-2 w-2 rounded-full" style={{ background: TYPE_INK[t] }} aria-hidden="true" />
              {STAT_LABEL[t]}
            </span>
          </li>
        ))}
      </ul>
      {active > 0 ? (
        <p className="text-x-12 text-x-muted">
          Filtered view.{' '}
          <button type="button" onClick={resetFilters} className="x-link pointer-events-auto">
            Show everything
          </button>
        </p>
      ) : (
        <p className="hidden text-x-12 text-x-muted md:block">Orbital data from CelesTrak. Positions are SGP4 estimates.</p>
      )}
    </div>
  );
}

export default function ExplorerPage() {
  const status = useExplorerStore((s) => s.status);
  const error = useExplorerStore((s) => s.error);
  const sceneError = useExplorerStore((s) => s.sceneError);
  const panelOpen = useExplorerStore((s) => s.panelOpen);
  const hasSelection = useExplorerStore((s) => s.selected !== null);
  const load = useExplorerStore((s) => s.load);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    void load();
  }, [load]);

  // Return focus to the Filters button when the filters page closes.
  useEffect(() => {
    if (wasOpen.current && !panelOpen) filtersButton.current?.focus();
    wasOpen.current = panelOpen;
  }, [panelOpen]);

  return (
    <div className="explorer relative h-full w-full overflow-hidden bg-x-bg font-x-body text-x-text">
      <GlobeCanvas />

      <div className="pointer-events-none absolute inset-0">
        <header className="x-over-globe flex flex-col items-center px-4 pt-4 md:pt-5">
          <SiteNav />
          <h1 className="x-display mt-4 text-x-28 md:mt-5 md:text-x-36">Aegis Orbit</h1>
          <p className="mt-2 text-center text-x-12 text-x-muted md:text-x-14">Every tracked object in Earth orbit, moving in real time</p>
        </header>

        <div className="absolute left-5 top-6 hidden md:block">
          <LiveClock />
        </div>

        {status === 'ready' && (
          <>
            <div className="absolute right-3 top-4 md:right-5 md:top-5">
              <FiltersButton buttonRef={filtersButton} />
            </div>
            <div className={`absolute inset-x-0 bottom-5 px-4 md:bottom-6 ${hasSelection ? 'max-md:hidden' : ''}`}>
              <Stats />
            </div>
            <DetailsCard />
            <FilterPanel />
          </>
        )}

        {status === 'loading' && (
          <p className="absolute inset-x-0 top-1/2 text-center text-x-14 text-x-muted" role="status">
            Loading the orbital catalog…
          </p>
        )}

        {status === 'error' && (
          <div className="x-panel pointer-events-auto absolute left-1/2 top-1/2 w-[min(440px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 p-5" role="alert">
            <h2 className="text-x-14 font-bold">Can’t load the catalog from {API_BASE}</h2>
            <p className="mt-2 text-x-12 text-x-muted">{error}</p>
            <p className="mt-2 text-x-12 text-x-muted">
              Start the backend with <code className="text-x-text">uvicorn app.main:app --reload</code> in <code className="text-x-text">backend/</code>, then retry.
            </p>
            <button type="button" onClick={() => void load()} className="x-button mt-4">
              Retry
            </button>
          </div>
        )}

        {sceneError && (
          <p className="absolute inset-x-6 top-1/2 text-center text-x-14 text-x-debris" role="alert">
            The 3D globe couldn’t start, so WebGL may be unavailable in this browser: {sceneError}
          </p>
        )}
      </div>
    </div>
  );
}
