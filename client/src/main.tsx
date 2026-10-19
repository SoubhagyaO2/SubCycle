import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// The Vite dev server proxies /api to the backend (see vite.config.ts). Set VITE_API_URL to call the API directly.
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App apiBaseUrl={apiBaseUrl} />
    </BrowserRouter>
  </StrictMode>,
);
