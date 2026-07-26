import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { UpdateToast } from './components/UpdateToast.js';
import { registerAppUpdates } from './lib/registerAppUpdates.js';
import { DmProvider } from './state/DmProvider.js';
import { TagProvider } from './state/TagProvider.js';
import { ToastProvider } from './state/ToastProvider.js';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <TagProvider>
        <DmProvider>
          <ToastProvider>
            <App />
            <UpdateToast />
          </ToastProvider>
        </DmProvider>
      </TagProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Installed copies update themselves. On iOS the installed copy is also what
// keeps a writer's tag from being evicted, so it has to stay healthy. The
// toast (above) is what tells a writer a new build is ready; this call is
// what watches for one and wires the reload up.
registerAppUpdates();
