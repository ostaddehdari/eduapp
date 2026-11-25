import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { welcomeTitle } from './app-model';

const root = document.getElementById('root');
if (!root) throw new Error('ROOT_ELEMENT_MISSING');

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>{welcomeTitle('مدرسه نمونه')}</h1>
      <p>پنل مدیریت EduApp</p>
    </main>
  </StrictMode>,
);
