import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { desktop } from './services/runtime';

// The app provides its own clip actions instead of the embedded browser menu.
document.addEventListener('contextmenu', event => event.preventDefault());
if (desktop) document.addEventListener('keydown', event => {
  if (['F5', 'F12'].includes(event.key) || (event.ctrlKey && !event.altKey && (['r', 'p', 's'].includes(event.key.toLowerCase()) || (event.shiftKey && ['i', 'j', 'c'].includes(event.key.toLowerCase()))))) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
