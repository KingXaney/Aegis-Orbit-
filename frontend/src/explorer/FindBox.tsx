import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findObjects } from './filters';
import { SearchIcon } from './icons';
import { TYPE_INK } from './palette';
import { revealGlobe } from './reveal';
import { useExplorerStore } from './store';

const MAX_RESULTS = 8;

/**
 * Find an object by name or NORAD ID: a combobox (WAI-ARIA 1.2 pattern) whose options select the
 * object and turn the globe to it. "/" focuses it from anywhere on the page.
 */
export default function FindBox() {
  const objects = useExplorerStore((s) => s.objects);
  const mask = useExplorerStore((s) => s.mask);
  const focus = useExplorerStore((s) => s.focus);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (k: number) => `${id}-option-${k}`;

  const results = useMemo(() => findObjects(objects, query, 40).filter((i) => mask[i]).slice(0, MAX_RESULTS), [objects, mask, query]);
  const expanded = open && query.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (index: number) => {
    focus(index);
    setQuery('');
    setOpen(false);
    revealGlobe();
  };

  return (
    <div className="relative">
      <label htmlFor={`${id}-input`} className="sr-only">
        Find an object by name or NORAD ID
      </label>
      <span className="pointer-events-none absolute left-3 top-3 text-x-muted">
        <SearchIcon />
      </span>
      <input
        ref={inputRef}
        id={`${id}-input`}
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && results.length ? optionId(active) : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && results.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => (a + 1) % results.length);
          } else if (e.key === 'ArrowUp' && results.length) {
            e.preventDefault();
            setActive((a) => (a - 1 + results.length) % results.length);
          } else if (e.key === 'Enter' && expanded && results.length) {
            e.preventDefault();
            choose(results[active]);
          } else if (e.key === 'Escape' && query) {
            e.stopPropagation();
            setQuery('');
          }
        }}
        placeholder="Find a satellite or debris, e.g. ISS…"
        autoComplete="off"
        spellCheck={false}
        className="x-field w-full pl-10 pr-10"
      />
      <kbd className="x-mono pointer-events-none absolute right-3 top-2.5 rounded-[4px] border border-x-divider px-1.5 text-x-12 text-x-muted" aria-hidden="true">
        /
      </kbd>
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching objects"
        hidden={!expanded}
        className="x-panel x-floating absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-[12px] p-1"
      >
        {results.length === 0 && (
          <li role="presentation" className="px-3 py-2 text-x-14 text-x-muted">
            No shown object matches. Check the filters.
          </li>
        )}
        {results.map((i, k) => (
          <li
            key={i}
            id={optionId(k)}
            role="option"
            aria-selected={k === active}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(k)}
            onClick={() => choose(i)}
            className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-[8px] px-3 text-x-14 ${k === active ? 'bg-x-raised' : ''}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_INK[objects[i].type] }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{objects[i].name}</span>
            <span className="x-mono text-x-12 text-x-muted">{objects[i].norad_id}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
