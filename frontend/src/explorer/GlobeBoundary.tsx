import { Component, type ReactNode } from 'react';
import { useExplorerStore } from './store';

/**
 * Keeps the rest of the page working when the globe can't load: a failed download of the Cesium
 * chunk, or an error while it starts. The message is shown by the page from `sceneError`.
 */
export default class GlobeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('Globe failed to load', error);
    useExplorerStore.getState().setSceneError(error.message);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
