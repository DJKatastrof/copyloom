import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeCaptureShortcut, validateSettings } from './library';
it('normalizes capture shortcuts without intercepting normal typing', () => {
  for (const key of ['PrintScreen','F8','F24','Ctrl+Alt+S']) expect(normalizeCaptureShortcut(key)).toBe(key);
  expect(normalizeCaptureShortcut('Alt+Ctrl+S')).toBe('Ctrl+Alt+S');
  expect(normalizeCaptureShortcut('Super+Shift+S')).toBe('Shift+Super+S');
  expect(validateSettings({ ...DEFAULT_SETTINGS, winV: true, captureShortcut: 'Super+Shift+S' }).captureShortcut).toBe('Shift+Super+S');
  for (const key of ['S','Shift+S','F25','Ctrl+Ctrl+S','Delete','']) expect(() => normalizeCaptureShortcut(key)).toThrow();
  expect(() => validateSettings({ ...DEFAULT_SETTINGS, captureShortcut: DEFAULT_SETTINGS.shortcut })).toThrow();
  expect(validateSettings({ ...DEFAULT_SETTINGS, captureShortcut: 'PrintScreen' }).captureShortcut).toBe('PrintScreen');
});
it('accepts the unchosen screenshot action the Windows app sends as null', () => {
  expect(validateSettings({ ...DEFAULT_SETTINGS, captureBehavior: null, captureShortcut: 'Shift+Super+S' }).captureShortcut).toBe('Shift+Super+S');
  expect(() => validateSettings({ ...DEFAULT_SETTINGS, captureBehavior: 'paste' as never })).toThrow('Invalid action after screenshot.');
});
