import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Maneuver } from '../types/api';
import { formatPc } from '../lib/format';

interface Row {
  id: string;
  label: string;
  miss: number;
  dv: number | null;
  pc: number | null;
  selected: boolean;
  approved: boolean;
  baseline: boolean;
}

export default function CandidateChart({ candidates, baselineMissKm, selectedId, approvedId, targetKm, onSelect }: { candidates: Maneuver[]; baselineMissKm: number; selectedId: string | null; approvedId: string | null; targetKm: number; onSelect: (id: string) => void }) {
  const rows: Row[] = [
    { id: 'baseline', label: 'no burn', miss: baselineMissKm, dv: null, pc: null, selected: false, approved: false, baseline: true },
    ...candidates.map((c) => ({
      id: c.maneuver_id,
      label: `${c.direction} ${c.dv_magnitude_mps.toFixed(2)}`,
      miss: c.post_miss_distance_km,
      dv: c.dv_magnitude_mps,
      pc: c.post_pc?.value ?? null,
      selected: c.maneuver_id === selectedId,
      approved: c.maneuver_id === approvedId,
      baseline: false,
    })),
  ];
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-dim">
        <span>Miss distance at closest approach (km)</span>
        <span className="text-warn">dashed: distance target {targetKm} km</span>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <BarChart data={rows} margin={{ top: 6, right: 6, left: -14, bottom: 0 }} barCategoryGap="28%">
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#7f90ad', fontFamily: 'ui-monospace, monospace' }} axisLine={{ stroke: '#1e2a42' }} tickLine={false} interval={0} />
          <YAxis tick={{ fontSize: 10, fill: '#7f90ad' }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            contentStyle={{ background: '#0b1220', border: '1px solid #1e2a42', borderRadius: 4, fontSize: 11, color: '#d7e1f2' }}
            formatter={(value: unknown, _name: unknown, item: { payload?: Row }) => {
              const r = item?.payload;
              const v = typeof value === 'number' ? value : Number(value);
              const extra = r && !r.baseline ? ` · Δv ${r.dv?.toFixed(2)} m/s · Pc ${formatPc(r.pc)}` : '';
              return [`${v.toFixed(3)} km${extra}`, r?.baseline ? 'original encounter' : r?.id];
            }}
            labelFormatter={() => ''}
          />
          <ReferenceLine y={targetKm} stroke="#fbbf24" strokeDasharray="4 4" />
          <Bar dataKey="miss" radius={[2, 2, 0, 0]} onClick={(d: unknown) => { const r = d as Row; if (r && !r.baseline) onSelect(r.id); }} cursor="pointer">
            {rows.map((r) => (
              <Cell key={r.id} fill={r.baseline ? '#f87171' : r.approved ? '#22c55e' : '#4ade80'} fillOpacity={r.baseline || r.selected || r.approved ? 1 : 0.45} stroke={r.selected ? '#d7e1f2' : 'none'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
