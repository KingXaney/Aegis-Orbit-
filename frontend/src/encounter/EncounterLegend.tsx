import type { EncounterThresholds } from './encounterMap';
import type { EncounterMode } from './scene';
import { CHASE } from './scene';
import { enlargementFactor } from './spacecraftModel';
import type { SpacecraftDesign } from '../types/api';

export default function EncounterLegend({ mode, thresholds, basis, count, spacecraft }: { mode: EncounterMode; thresholds: EncounterThresholds; basis: 'perception' | 'screening' | 'none'; count: number; spacecraft: SpacecraftDesign | null }) {
  const model = spacecraft ? `${spacecraft.label} model` : 'spacecraft model';
  const times = spacecraft ? `×${Math.round(enlargementFactor(spacecraft, CHASE.SAT_SPAN_KM))}` : '×10';
  return (
    <div className="pointer-events-none absolute bottom-[92px] right-3 w-[270px] rounded border border-line bg-panel/85 p-2.5 text-[10px] leading-snug text-muted backdrop-blur">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold uppercase tracking-[0.18em] text-muted">{mode === 'map' ? 'Encounter map' : 'Chase camera'}</span>
        <span className="text-dim">{count} tracked · {basis === 'perception' ? 'ML + physics' : basis === 'screening' ? 'screening only' : 'no data'}</span>
      </div>
      <div className="mb-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-3 rounded-sm border border-threat bg-tracked/60" /> critical</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-3 rounded-sm border border-tracked bg-tracked/40" /> semi-critical</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-3 rounded-sm border border-tracked/40 bg-tracked/20" /> model watch, cleared</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-1.5 w-3 rounded-sm bg-[#2dd4bf]" /> planned path</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-0.5 w-3 border-t border-dashed border-primary" /> original path</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rotate-45 bg-[#a3e635]" /> burn</span>
      </div>
      {mode === 'map' ? (
        <p>
          Ahead = time to each object's closest approach (linear to 10 min, then logarithmic to {Math.round(thresholds.horizonS / 3600)} h). Sideways = the computed miss offset in km (linear to 3 km, logarithmic to the {thresholds.trackedKm} km screening radius at the road edge). Critical objects appear anywhere in the horizon; others only within {Math.round(thresholds.nearFieldS / 60)} min. The {model} is enlarged to the ribbon width and boxes are schematic; printed distances and times come from the physics engine.
        </p>
      ) : (
        <p>
          True relative positions in the satellite's frame, {CHASE.VISIBILITY_KM} km visibility. The {model} is drawn {times} life size; boxes are 250 m up close and grow with distance so far objects stay visible. At orbital speeds an object crosses this view in a few seconds: use 1× speed or scrub near the closest approach.
        </p>
      )}
    </div>
  );
}
