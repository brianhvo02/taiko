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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
