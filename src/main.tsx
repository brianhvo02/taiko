import '@fontsource/shippori-mincho/500.css';
import '@fontsource/shippori-mincho/700.css';
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import './ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { store } from './player/store';

// For tests against the dev server: lets a test read the true position and listen to the audio element.
if (import.meta.env.DEV) (window as unknown as { taikoStore: typeof store }).taikoStore = store;

// The built site keeps itself for opening with no connection (public/sw.js). The dev server doesn't: a kept copy
// would get in the way of changes.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    // What this page fetched before the worker was there (the fonts for the text on screen) is handed to it to keep.
    void navigator.serviceWorker.ready.then((registration) => {
      const fetched = performance.getEntriesByType('resource').map((entry) => new URL(entry.name)).filter((url) => url.origin === location.origin && url.pathname.startsWith('/assets/'));
      registration.active?.postMessage({ keep: [...new Set(fetched.map((url) => url.pathname))] });
    }).catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
