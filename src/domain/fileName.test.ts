import { expect, it } from 'vitest';
import { imageFileName } from './fileName';

const capturedAt = new Date(2026, 9, 7, 9, 5, 3).getTime();
it('names images after program and local capture time, or the name the user gave the clip', () => {
  expect(imageFileName({ createdAt: capturedAt, source: 'Microsoft Teams' })).toBe('Microsoft Teams 2026-10-07 090503.png');
  expect(imageFileName({ createdAt: capturedAt, source: '  ' })).toBe('Copyloom 2026-10-07 090503.png');
  expect(imageFileName({ createdAt: capturedAt })).toBe('Copyloom 2026-10-07 090503.png');
  expect(imageFileName({ createdAt: capturedAt, source: 'Edge', customTitle: ' Kvitto mars ' })).toBe('Kvitto mars.png');
});
