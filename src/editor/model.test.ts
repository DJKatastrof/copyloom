import { describe, expect, it } from 'vitest';
import { bounds, commit, cropShape, emptyHistory, fitView, hitHandle, hitTest, imageBounds, moveShape, nextStepNumber, normalizeShape, clampView, pixelateGrid, redo, resizeShape, snapView, toImage, toScreen, undo, zoomAt } from './model';
import type { Shape } from './model';
const box: Shape = { id: 'a', kind: 'rectangle', x1: 20, y1: 30, x2: 120, y2: 80, color: '#000000', stroke: 4 };
it('repeated crops retain original coordinates and undo restores full bounds without losing annotations', () => {
  const image = { width: 800, height: 480 }, first = cropShape({ ...box, id: 'crop', kind: 'crop', x1: 100.7, y1: 80.2, x2: 701.1, y2: 400.2 }, imageBounds(image, []))!;
  expect(bounds(first)).toEqual({ x: 101, y: 80, width: 600, height: 320 });
  const cropped = commit(commit(emptyHistory(), [box]), [box, first]);
  const second = cropShape({ ...first, id: 'crop2', x1: 110, y1: 90, x2: 1000, y2: 1000 }, imageBounds(image, cropped.present))!;
  const twice = commit(cropped, [...cropped.present, second]);
  expect(imageBounds(image, twice.present)).toEqual({ x: 110, y: 90, width: 591, height: 310 });
  expect(imageBounds(image, undo(undo(twice)).present)).toEqual({ x: 0, y: 0, width: 800, height: 480 });
  expect(undo(undo(twice)).present).toEqual([box]);
  expect(cropShape({ ...first, x1: 900, x2: 900 }, imageBounds(image, []))).toBeNull();
});
it('numbered steps continue from the highest retained number', () => {
  expect(nextStepNumber([])).toBe(1);
  expect(nextStepNumber([{ ...box, kind: 'step', number: 3 }, { ...box, kind: 'step', number: 8 }])).toBe(9);
});
describe('editor geometry', () => {
  it('round trips image coordinates at fit, 100%, 200% and arbitrary pan', () => {
    for (const zoom of [0.3125, 1, 2, 7.3]) {
      const view = { x: -183.5, y: 94, zoom }, p = { x: 1203.75, y: 513.125 };
      expect(toImage(toScreen(p, view), view)).toEqual(p);
      const anchored = zoomAt(view, { x: 320, y: 240 }, 2);
      expect(toImage({ x: 320, y: 240 }, anchored)).toEqual(toImage({ x: 320, y: 240 }, view));
    }
    expect(fitView(3840, 2160, { width: 1200, height: 800 }).zoom).toBe(0.3);
  });
  it('keeps the image in view: centred where it fits, edges stop 24 px inside otherwise', () => {
    const area = { width: 1000, height: 600 }, image = { width: 800, height: 480 };
    expect(clampView({ x: -5000, y: 9000, zoom: 1 }, image, area)).toEqual({ x: 100, y: 60, zoom: 1 });
    expect(clampView({ x: -5000, y: 9000, zoom: 2 }, image, area)).toEqual({ x: 1000 - 1600 - 24, y: 24, zoom: 2 });
    expect(clampView({ x: -300, y: -200, zoom: 2 }, image, area)).toEqual({ x: -300, y: -200, zoom: 2 });
    // A dimension that only just overflows is still pannable within the margin.
    expect(clampView({ x: 0, y: 0, zoom: 1 }, { width: 960, height: 100 }, area)).toEqual({ x: 16, y: 250, zoom: 1 });
  });
  it('fits small captures at actual screen pixels and snaps offsets to the pixel grid', () => {
    const fitted = fitView(405, 377, { width: 1083, height: 600 }, 1 / 1.5);
    expect(fitted.zoom).toBeCloseTo(1 / 1.5, 12);
    const snapped = snapView(fitted, 1.5);
    for (const value of [snapped.x * 1.5, snapped.y * 1.5]) expect(Math.abs(value - Math.round(value))).toBeLessThan(1e-9);
    expect(Math.abs(snapped.x - fitted.x)).toBeLessThanOrEqual(1 / 3);
    expect(snapView({ x: 10.25, y: -3.5, zoom: 2 }, 1)).toEqual({ x: 10, y: -3, zoom: 2 });
  });
  it('selects and resizes boxes and arrow endpoints', () => {
    expect(hitTest(box, { x: 50, y: 50 }, 2)).toBe(true); expect(hitTest(box, { x: 200, y: 50 }, 2)).toBe(false);
    expect(hitHandle(box, { x: 121, y: 81 }, 2)).toBe('se');
    expect(bounds(resizeShape(box, 'nw', { x: 0, y: 0 }))).toEqual({ x: 0, y: 0, width: 120, height: 80 });
    const arrow = { ...box, kind: 'arrow' as const };
    expect(hitTest(arrow, { x: 70, y: 55 }, 2)).toBe(true); expect(hitTest(arrow, { x: 70, y: 100 }, 2)).toBe(false);
    expect(resizeShape(arrow, 'start', { x: 1, y: 2 })).toMatchObject({ x1: 1, y1: 2, x2: 120, y2: 80 });
  });
  it('clamps movement to the image and normalizes every drag direction', () => {
    expect(moveShape(box, -100, 500, 300, 200)).toMatchObject({ x1: 0, y1: 150, x2: 100, y2: 200 });
    expect(normalizeShape({ ...box, x1: 120, x2: 20, y1: 80, y2: 30 })).toEqual(box);
  });
  it('step handles scale the numeral and preserve a circle anchored at the opposite corner', () => {
    const step: Shape = { ...box, kind: 'step', x1: 100, y1: 100, x2: 130, y2: 130, number: 1, fontSize: 18 };
    expect(resizeShape(step, 'se', { x: 160, y: 150 })).toMatchObject({ x1: 100, y1: 100, x2: 160, y2: 160, fontSize: 36, number: 1 });
    expect(resizeShape(step, 'nw', { x: 70, y: 80 })).toMatchObject({ x1: 70, y1: 70, x2: 130, y2: 130, fontSize: 36 });
    expect(resizeShape(step, 'n', { x: 115, y: 70 })).toMatchObject({ x1: 85, y1: 70, x2: 145, y2: 130, fontSize: 36 });
  });
  it('undoes a whole gesture and drops redo after another edit', () => {
    const first = commit(emptyHistory(), [box]), second = commit(first, [moveShape(box, 10, 0, 500, 500)]);
    expect(undo(second).present).toEqual([box]); expect(redo(undo(second))).toEqual(second);
    expect(commit(undo(second), []).future).toEqual([]); expect(first.present).toEqual([box]);
  });
  it('averages edge blocks and preserves alpha without hidden RGB leakage', () => {
    const result = pixelateGrid(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 1, 2, 3, 255]), 3, 1, 2);
    expect(result.width).toBe(2); expect([...result.data]).toEqual([128, 0, 128, 255, 1, 2, 3, 255]);
    expect([...pixelateGrid(new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]), 2, 1, 2).data]).toEqual([0, 0, 255, 128]);
  });
});
