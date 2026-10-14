import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/silkscreen/latin-700.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
