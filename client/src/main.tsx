import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// Placeholder shell. Pages, routing, auth context and the API client arrive in Stage 7.
function App() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">SubCycle</h1>
      <p className="mt-2 text-gray-600">Frontend is built in Stage 7.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
