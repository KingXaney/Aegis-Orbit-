import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

// Two pages without a router: the catalog explorer at /, the mission simulator under /mission. Each is
// loaded on its own, so the explorer doesn't download the simulator's charts (and can paint its text
// before Cesium arrives).
const mission = window.location.pathname.startsWith('/mission');
const Page = lazy(() => (mission ? import('./App') : import('./explorer/ExplorerPage')));
// The explorer sets its own 16 px root size (the simulator keeps its 13 px one), so its rem-based
// spacing lands on a true 4 px grid.
if (!mission) document.documentElement.classList.add('x-root');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </React.StrictMode>,
);
