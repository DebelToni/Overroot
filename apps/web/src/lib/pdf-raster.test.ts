import { expect, it } from 'vitest';
import { pageMillimetres, rasterScale } from './pdf-raster';

it('keeps poster previews inside the bitmap budget', () => {
  const ratio = rasterScale(8426, 5944, 2);
  expect(8426 * ratio).toBeLessThanOrEqual(4096);
  expect(8426 * 5944 * ratio * ratio).toBeLessThanOrEqual(16_000_000);
  expect(rasterScale(600, 800, 2)).toBe(2);
});

it('reports physical size from PDF points', () => {
  expect(pageMillimetres(841 * 72 / 25.4, 594 * 72 / 25.4)).toEqual({ width: 841, height: 594 });
});
