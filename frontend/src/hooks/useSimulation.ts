import { useSyncExternalStore } from 'react';
import { controller, type ControllerState } from '../simulation/controller';

let cached: ControllerState = controller.snapshot;
let unsubscribe: (() => void) | null = null;
const subscribers = new Set<() => void>();

function ensureSubscribed() {
  if (unsubscribe) return;
  unsubscribe = controller.subscribe((s) => {
    cached = s;
    for (const fn of subscribers) fn();
  });
}

/** Throttled view of the simulation clock for React components. */
export function useSimulation(): ControllerState {
  return useSyncExternalStore(
    (cb) => {
      ensureSubscribed();
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    () => cached,
    () => cached,
  );
}
