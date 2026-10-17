import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OrbitClass } from '../types/api';
import { MAX_PATHS, OBJECT_TYPES, activeFilterCount, ORBIT_CLASSES, ORBIT_CLASS_LABEL, TYPE_LABEL, findObjects } from './filters';
import { CheckIcon, CloseIcon } from './icons';
import { TYPE_INK } from './palette';
import { ownerName } from './owners';
import { useExplorerStore } from './store';

const nf = new Intl.NumberFormat('en-US');
const TOP_OWNERS = 12;

const CLASS_HINT: Record<OrbitClass, string> = {
  LEO: 'Below 2,000 km',
  MEO: '2,000 km to GEO',
  GEO: 'One orbit a day',
  HEO: 'Long, elliptical',
};

function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-x-12 font-bold text-x-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Count() {
  const visible = useExplorerStore((s) => s.visible);
  const total = useExplorerStore((s) => s.objects.length);
  return (
    <p className="text-x-14 leading-tight text-x-muted" aria-live="polite">
      <span className="text-x-21 font-bold tabular-nums text-x-text">{nf.format(visible)}</span> of {nf.format(total)} shown
    </p>
  );
}

function Find() {
  const objects = useExplorerStore((s) => s.objects);
  const mask = useExplorerStore((s) => s.mask);
  const focus = useExplorerStore((s) => s.focus);
  const [query, setQuery] = useState('');
  const results = useMemo(() => findObjects(objects, query, 40).filter((i) => mask[i]).slice(0, 8), [objects, mask, query]);
  return (
    <div className="relative">
      <label htmlFor="find-object" className="sr-only">Find by name or NORAD ID</label>
      <input
        id="find-object"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length) {
            focus(results[0]);
            setQuery('');
          }
        }}
        placeholder="Find by name or NORAD ID"
        autoComplete="off"
        className="x-field w-full"
      />
      {query.trim() && (
        <ul className="mt-1 overflow-hidden rounded-lg border border-x-divider bg-x-bg/90" role="listbox" aria-label="Matching objects">
          {results.length === 0 && <li className="px-3 py-2 text-x-12 text-x-muted">No shown object matches. Check the filters below.</li>}
          {results.map((i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  focus(i);
                  setQuery('');
                }}
                className="x-focus flex w-full items-center gap-2 px-3 py-1.5 text-left text-x-14 hover:bg-white/5"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_INK[objects[i].type] }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{objects[i].name}</span>
                <span className="text-x-12 text-x-muted">{objects[i].norad_id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Types() {
  const types = useExplorerStore((s) => s.filters.types);
  const byType = useExplorerStore((s) => s.visibleByType);
  const toggleType = useExplorerStore((s) => s.toggleType);
  return (
    <Group title="Type">
      <ul className="-mx-2">
        {OBJECT_TYPES.map((t) => (
          <li key={t}>
            <label className="x-row">
              <input type="checkbox" className="peer sr-only" checked={types[t]} onChange={() => toggleType(t)} />
              <span
                className="h-3 w-3 shrink-0 rounded-full border-2 transition-colors"
                style={{ borderColor: TYPE_INK[t], background: types[t] ? TYPE_INK[t] : 'transparent' }}
                aria-hidden="true"
              />
              <span className={`flex-1 ${types[t] ? '' : 'text-x-muted'}`}>{TYPE_LABEL[t]}</span>
              <span className="tabular-nums text-x-12 text-x-muted">{types[t] ? nf.format(byType[t]) : 'Hidden'}</span>
            </label>
          </li>
        ))}
      </ul>
    </Group>
  );
}

function Classes() {
  const classes = useExplorerStore((s) => s.filters.classes);
  const toggleClass = useExplorerStore((s) => s.toggleClass);
  return (
    <Group title="Orbit class">
      <div className="grid grid-cols-2 gap-1.5">
        {ORBIT_CLASSES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={classes[c]}
            title={ORBIT_CLASS_LABEL[c]}
            onClick={() => toggleClass(c)}
            className={`x-focus rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              classes[c] ? 'border-x-text/40 bg-white/[0.06] text-x-text' : 'border-x-divider text-x-muted hover:text-x-text'
            }`}
          >
            <span className="block text-x-14 font-bold">{c}</span>
            <span className="block text-x-12 text-x-muted">{CLASS_HINT[c]}</span>
          </button>
        ))}
      </div>
    </Group>
  );
}

function Operators() {
  const owners = useExplorerStore((s) => s.owners);
  const selected = useExplorerStore((s) => s.filters.owners);
  const toggleOwner = useExplorerStore((s) => s.toggleOwner);
  const clearOwners = useExplorerStore((s) => s.clearOwners);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const q = query.trim().toLowerCase();
  const filtered = q ? owners.filter((o) => ownerName(o.code).toLowerCase().includes(q) || o.code.toLowerCase().includes(q)) : owners;
  // Selected operators stay in view even when they are outside the top of the list.
  const shown = q || showAll ? filtered : [...filtered.slice(0, TOP_OWNERS), ...filtered.slice(TOP_OWNERS).filter((o) => selected.includes(o.code))];
  return (
    <Group
      title="Country or operator"
      action={
        selected.length > 0 && (
          <button type="button" onClick={clearOwners} className="x-link text-x-14">
            Show all
          </button>
        )
      }
    >
      <label htmlFor="find-operator" className="sr-only">Filter the operator list</label>
      <input id="find-operator" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter operators" autoComplete="off" className="x-field mb-1 w-full" />
      <ul className="-mx-2">
        {shown.map((o) => {
          const on = selected.includes(o.code);
          return (
            <li key={o.code}>
              <label className="x-row">
                <input type="checkbox" className="peer sr-only" checked={on} onChange={() => toggleOwner(o.code)} />
                <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${on ? 'border-x-text bg-x-text' : 'border-x-muted/60'}`} aria-hidden="true">
                  {on && (
                    <span className="text-x-bg">
                      <CheckIcon />
                    </span>
                  )}
                </span>
                <span className={`min-w-0 flex-1 truncate ${on || selected.length === 0 ? '' : 'text-x-muted'}`}>{ownerName(o.code)}</span>
                <span className="tabular-nums text-x-12 text-x-muted">{nf.format(o.count)}</span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2 py-1 text-x-12 text-x-muted">No operator matches “{query}”.</li>}
      </ul>
      {!q && filtered.length > TOP_OWNERS && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="x-link mt-2 self-start text-x-14">
          {showAll ? 'Show fewer' : `Show all ${filtered.length} operators`}
        </button>
      )}
      {selected.length === 0 && <p className="mt-1 text-x-12 text-x-muted">Showing every operator. Check one or more to narrow it down.</p>}
    </Group>
  );
}

function Paths() {
  const showPaths = useExplorerStore((s) => s.showPaths);
  const setShowPaths = useExplorerStore((s) => s.setShowPaths);
  const visible = useExplorerStore((s) => s.visible);
  return (
    <Group title="Orbit paths">
      <label className="x-row -mx-2">
        <input type="checkbox" role="switch" className="peer sr-only" checked={showPaths} onChange={() => setShowPaths(!showPaths)} />
        <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${showPaths ? 'bg-x-accent' : 'bg-x-divider'}`} aria-hidden="true">
          <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-x-text transition-transform ${showPaths ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </span>
        <span className="flex-1">Draw orbits of shown objects</span>
      </label>
      {showPaths && visible > MAX_PATHS && (
        <p className="mt-1 text-x-12 leading-snug text-x-muted">
          Narrow the filters to {MAX_PATHS} objects or fewer to draw every orbit. The selected object’s orbit always shows.
        </p>
      )}
    </Group>
  );
}

/** The filters page: a sheet from the right on desktop, full screen on phones. The globe stays live behind it. */
export default function FilterPanel() {
  const open = useExplorerStore((s) => s.panelOpen);
  const setOpen = useExplorerStore((s) => s.setPanelOpen);
  const active = useExplorerStore((s) => activeFilterCount(s.filters));
  const resetFilters = useExplorerStore((s) => s.resetFilters);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <aside
      id="filter-panel"
      role="dialog"
      aria-label="Filters"
      className="x-panel x-floating x-sheet-in fixed inset-0 z-40 flex flex-col rounded-none md:inset-y-4 md:left-auto md:right-4 md:w-[380px] md:rounded-[12px]"
    >
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
        <h2 className="x-display text-x-28">Filters</h2>
        <button ref={closeRef} type="button" onClick={() => setOpen(false)} className="x-button border-transparent bg-transparent px-0" aria-label="Close filters">
          <CloseIcon />
        </button>
      </div>
      <div className="px-5 pb-4">
        <Count />
      </div>
      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto border-t border-x-divider px-5 py-5">
        <Find />
        <div className="mt-6">
          <Types />
          <Classes />
          <Operators />
          <Paths />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-x-divider px-5 py-4">
        <button type="button" onClick={resetFilters} disabled={active === 0} className="x-link disabled:text-x-muted disabled:no-underline">
          Reset filters
        </button>
        <button type="button" onClick={() => setOpen(false)} className="x-button x-button-primary">
          Show results
        </button>
      </div>
    </aside>
  );
}
