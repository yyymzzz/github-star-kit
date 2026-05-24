import React from 'react';
import { createRoot } from 'react-dom/client';
import { Manage } from './Manage.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Manage root element #root not found in DOM');
}

createRoot(container).render(
  <React.StrictMode>
    <Manage />
  </React.StrictMode>
);
