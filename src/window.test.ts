import { expect, it } from 'vitest';
import { fitWindowSize } from './window';

it('fits a QHD window inside an FHD monitor while reserving taskbar and decorations', () => {
  expect(
    fitWindowSize({ width: 2560, height: 1440 }, { width: 1920, height: 1040 }, 1, {
      width: 16,
      height: 39,
    }),
  ).toEqual({ width: 1872, height: 969, adjusted: true });
});

it('uses Windows DPI scaling when fitting and keeps smaller presets unchanged', () => {
  expect(
    fitWindowSize({ width: 1920, height: 1080 }, { width: 2560, height: 1400 }, 1.5, {
      width: 24,
      height: 60,
    }),
  ).toEqual({ width: 1658, height: 861, adjusted: true });
  expect(
    fitWindowSize({ width: 1280, height: 720 }, { width: 2560, height: 1400 }, 1.5, {
      width: 24,
      height: 60,
    }),
  ).toEqual({ width: 1280, height: 720, adjusted: false });
});
