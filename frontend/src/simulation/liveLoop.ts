import { controller } from './controller';
import { useAppStore } from '../store/useAppStore';

let stop: (() => void) | null = null;

/**
 * Feeds every clock notification to the store (rolling orbit data, sandbox evaluation, slow motion
 * around passes). One subscription for the page, however many times React mounts the effect.
 */
export function startLiveLoop(): () => void {
  if (!stop) {
    const unsubscribe = controller.subscribe((state) => useAppStore.getState().onClockTick(state));
    stop = () => {
      unsubscribe();
      stop = null;
    };
  }
  return () => stop?.();
}
