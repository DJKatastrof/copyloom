'use strict';

// The Ko-fi page, for example 'https://ko-fi.com/copyloom'. The support button and its note appear once it is set.
const koFiUrl = 'https://ko-fi.com/copyloom';

if (koFiUrl) {
  const destination = new URL(koFiUrl);
  if (destination.protocol !== 'https:') throw new Error('Use an HTTPS Ko-fi URL.');
  for (const element of document.querySelectorAll('[data-donate]')) { if (element.tagName === 'A') element.href = destination.href; element.hidden = false; }
}

const screenshots = [
  { src: 'assets/library.png', caption: 'The Copyloom library · example content', alt: 'Copyloom library showing example clips and a project handover preview.' },
  { src: 'assets/library-dark.png', caption: 'The library in dark mode · example content', alt: 'Copyloom in dark mode, showing an example PowerShell command.' },
  { src: 'assets/image-editor.png', caption: 'The Copyloom image editor · sample capture', alt: 'Copyloom image editor with numbered steps, an arrow and highlighted text.' },
];
const dialog = document.getElementById('screenshot-dialog');
const fullImage = document.getElementById('screenshot-full');
const caption = document.getElementById('screenshot-caption');
const position = document.getElementById('screenshot-position');
let current = 0, opener = null;
function showScreenshot(index) {
  current = (index + screenshots.length) % screenshots.length;
  const shot = screenshots[current];
  fullImage.src = shot.src; fullImage.alt = shot.alt;
  caption.textContent = shot.caption;
  position.textContent = `${current + 1} / ${screenshots.length}`;
}
for (const link of document.querySelectorAll('[data-screenshot]')) link.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || typeof dialog.showModal !== 'function') return;
  event.preventDefault(); opener = link;
  showScreenshot(Number(link.dataset.screenshot));
  dialog.showModal();
});
dialog.querySelector('[data-previous]').addEventListener('click', () => showScreenshot(current - 1));
dialog.querySelector('[data-next]').addEventListener('click', () => showScreenshot(current + 1));
dialog.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); showScreenshot(current + (event.key === 'ArrowLeft' ? -1 : 1)); }
});
dialog.addEventListener('close', () => opener?.focus({ preventScroll: true }));
dialog.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
});

// The logo goes back to the top with a clean address (copyloom.app/), not copyloom.app/#top.
for (const link of document.querySelectorAll('a[href="#top"]')) link.addEventListener('click', event => {
  event.preventDefault();
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  history.replaceState(null, '', location.pathname + location.search);
});
