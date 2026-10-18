import { useEffect } from 'react';
import { useAppStore, type AgentMode } from '../store/useAppStore';

export const SETTINGS_PANEL_ID = 'settings-panel';

const AGENT_OPTIONS: { mode: AgentMode; label: string; detail: string }[] = [
  { mode: 'gemini', label: 'Gemini', detail: 'Chooses which tools to call and writes the explanation. The backend validates its recommendation.' },
  { mode: 'deterministic', label: 'Deterministic', detail: 'Runs the same tool workflow from fixed rules and writes a templated explanation. Works offline.' },
];

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const agentMode = useAppStore((s) => s.agentMode);
  const setAgentMode = useAppStore((s) => s.setAgentMode);
  const health = useAppStore((s) => s.health);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div id={SETTINGS_PANEL_ID} className="mt-1.5 border-t border-line px-1.5 pb-1 pt-2 text-[11px]">
      <fieldset>
        <legend className="display mb-1.5 text-[14px] text-text">Agent model</legend>
        <div className="space-y-1.5">
          {AGENT_OPTIONS.map((o) => (
            <label key={o.mode} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="agent-mode"
                value={o.mode}
                checked={agentMode === o.mode}
                onChange={() => setAgentMode(o.mode)}
                className="mt-0.5 accent-[var(--color-primary)]"
              />
              <span>
                <span className="text-text">{o.label}</span>
                {o.mode === 'gemini' && health && <span className="mono ml-1.5 text-dim">{health.gemini_model}</span>}
                <span className="block text-dim">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {agentMode === 'gemini' && health && !health.gemini_configured && (
        <div className="mt-2 text-warn">No GEMINI_API_KEY is set on the backend, so runs fall back to the deterministic agent until one is added.</div>
      )}
      <div className="mt-1.5 text-dim">Applies to the next Analyze run.</div>
    </div>
  );
}
