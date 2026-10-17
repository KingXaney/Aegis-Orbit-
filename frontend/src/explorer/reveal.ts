/** On phones the globe sits above the rail; bring it into view when something is shown on it. */
export function revealGlobe(): void {
  const globe = document.getElementById('globe');
  if (!globe) return;
  const r = globe.getBoundingClientRect();
  const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  if (visible >= r.height * 0.6) return;
  globe.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
