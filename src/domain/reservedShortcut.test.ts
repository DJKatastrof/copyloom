import { it, expect } from 'vitest';
import { normalizeShortcut, normalizeCaptureShortcut } from './library';
it('explains the Windows reservation for F12 and accepts F11', () => {
  for (const key of ['Ctrl+Shift+F12', 'Alt+F12']) {
    expect(() => normalizeShortcut(key)).toThrow('F12 is reserved by Windows');
    expect(() => normalizeCaptureShortcut(key)).toThrow('F12 is reserved by Windows');
  }
  expect(() => normalizeCaptureShortcut('F12')).toThrow('F12 is reserved by Windows');
  expect(normalizeShortcut('Ctrl+Shift+F11')).toBe('Ctrl+Shift+F11');
  expect(normalizeCaptureShortcut('Ctrl+Alt+F11')).toBe('Ctrl+Alt+F11');
});
