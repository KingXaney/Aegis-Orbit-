import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ExplorerPage from './explorer/ExplorerPage';
import './index.css';

// Two pages without a router: the catalog explorer at /, the mission simulator under /mission.
const Page = window.location.pathname.startsWith('/mission') ? App : ExplorerPage;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
