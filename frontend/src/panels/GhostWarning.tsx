import { Badge, Button } from '../components/ui';
import { useSimulation } from '../hooks/useSimulation';
import { formatCountdown } from '../lib/format';
import { formatMiss, ghostWarning, ghostWarningText } from '../simulation/ghosts';
import { useAppStore } from '../store/useAppStore';

/**
 * The warning before a ghost meets the debris its burn avoided (and the moment it does): what would
 * have happened without the dodge. Shown bottom right, above the close-up, in every scenario.
 */
export default function GhostWarning({ className = '' }: { className?: string }) {
  const sim = useSimulation();
  const ghosts = useAppStore((s) => s.ghosts);
  const insetTarget = useAppStore((s) => s.insetTarget);
  const setInsetTarget = useAppStore((s) => s.setInsetTarget);
  const warn = ghostWarning(ghosts, sim.currentUnix);
  if (!warn) return null;
  const { ghost, dt, phase } = warn;
  const watching = insetTarget === ghost.id;
  return (
    <div role="alert" aria-live="polite" className={className}>
      <div className="rounded border border-threat bg-panel/95 p-2.5 text-[10px] backdrop-blur" style={{ boxShadow: '0 0 0 1px var(--color-threat), 0 0 18px color-mix(in srgb, var(--color-threat) 45%, transparent)' }}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold uppercase tracking-[0.18em] text-threat">{phase === 'crashed' ? 'Ghost collision' : 'Ghost collision ahead'}</span>
          <Badge tone="threat">{phase === 'crashed' ? 'now' : formatCountdown(dt)}</Badge>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text">{ghostWarningText(ghost, dt)}</p>
        <div className="mt-2 flex items-center justify-between gap-2 text-muted">
          <span>
            Ghost {ghost.index}: the course without the dodge burn, {formatMiss(ghost.missKm)} from {ghost.secondaryName} at closest approach.
          </span>
          {!watching && phase === 'warning' && (
            <Button size="sm" variant="ghost" onClick={() => setInsetTarget(ghost.id)} title="Follow the ghost in the close-up">
              Watch
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
