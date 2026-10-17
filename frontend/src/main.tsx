import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ExplorerPage from './explorer/ExplorerPage';
import './index.css';

// Two pages without a router: the catalog explorer at /, the mission simulator under /mission.
const mission = window.location.pathname.startsWith('/mission');
const Page = mission ? App : ExplorerPage;
// The explorer sets its own 16 px root size (the simulator keeps its 13 px one), so its rem-based
// spacing lands on a true 4 px grid.
if (!mission) document.documentElement.classList.add('x-root');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
