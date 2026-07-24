import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import { TagProvider } from './state/TagProvider.js';
import { ToastProvider } from './state/ToastProvider.js';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <TagProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TagProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Installed copies update themselves. On iOS the installed copy is also what
// keeps a writer's tag from being evicted, so it has to stay healthy.
registerSW({ immediate: true });
