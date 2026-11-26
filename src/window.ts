import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from '@tauri-apps/api/window';
import { windowSizes } from './settings';

export function fitWindowSize(
  requested: { width: number; height: number },
  workArea: { width: number; height: number },
  scaleFactor: number,
  frame: { width: number; height: number },
) {
  const width = Math.min(
    requested.width,
    Math.max(760, Math.floor((workArea.width - frame.width) / scaleFactor) - 32),
  );
  const height = Math.min(
    requested.height,
    Math.max(560, Math.floor((workArea.height - frame.height) / scaleFactor) - 32),
  );
  return { width, height, adjusted: width !== requested.width || height !== requested.height };
}

export async function applyWindowSize(id: string) {
  const requested = windowSizes.find((size) => size.id === id)!;
  const appWindow = getCurrentWindow();
  if (await appWindow.isMaximized()) await appWindow.unmaximize();
  const [monitor, inner, outer, scaleFactor] = await Promise.all([
    currentMonitor(),
    appWindow.innerSize(),
    appWindow.outerSize(),
    appWindow.scaleFactor(),
  ]);
  const fitted = monitor
    ? fitWindowSize(requested, monitor.workArea.size, scaleFactor, {
        width: outer.width - inner.width,
        height: outer.height - inner.height,
      })
    : { width: requested.width, height: requested.height, adjusted: false };
  await appWindow.setSize(new LogicalSize(fitted.width, fitted.height));
  if (monitor) {
    // Physical coordinates preserve the correct monitor at mixed DPI scales.
    const frameWidth = outer.width - inner.width;
    const frameHeight = outer.height - inner.height;
    await appWindow.setPosition(
      new PhysicalPosition(
        Math.round(
          monitor.workArea.position.x +
            Math.max(
              0,
              (monitor.workArea.size.width - fitted.width * scaleFactor - frameWidth) / 2,
            ),
        ),
        Math.round(
          monitor.workArea.position.y +
            Math.max(
              0,
              (monitor.workArea.size.height - fitted.height * scaleFactor - frameHeight) / 2,
            ),
        ),
      ),
    );
  }
  return fitted;
}
