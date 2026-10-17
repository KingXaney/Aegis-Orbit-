// The explorer's icons: one 16 px grid, one 1.5 px stroke, round caps. Decorative, so hidden from
// assistive tech; the control that holds one carries the label.

const base = {
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export function CloseIcon() {
  return (
    <svg {...base}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function FiltersIcon() {
  return (
    <svg {...base}>
      <path d="M2.5 4.5h6M12.5 4.5h1M2.5 11.5h1M7.5 11.5h6" />
      <circle cx="10.5" cy="4.5" r="2" />
      <circle cx="5.5" cy="11.5" r="2" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...base}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25l3.25 3.25" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base} viewBox="0 0 16 16" width={12} height={12} strokeWidth={2}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** A detected object on the globe: a thin ring (decorative; the text beside it names it). */
export function DetectedMark({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" focusable={false}>
      <circle cx="6" cy="6" r="4" fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

/** A critical pass: the double ring used on the globe, in the warning colour. */
export function CriticalMark() {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" focusable={false}>
      <circle cx="6" cy="6" r="2.5" fill="none" stroke="var(--x-warning)" strokeWidth="1.5" />
      <circle cx="6" cy="6" r="5.25" fill="none" stroke="var(--x-warning)" strokeWidth="1.25" />
    </svg>
  );
}
