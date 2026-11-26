export type Settings = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorBlink: boolean;
  windowSize: string;
};

export const windowSizes = [
  { id: '1280x720', width: 1280, height: 720, label: '1280 × 720 · HD' },
  { id: '1366x768', width: 1366, height: 768, label: '1366 × 768 · 노트북' },
  { id: '1440x900', width: 1440, height: 900, label: '1440 × 900 · 기본' },
  { id: '1600x900', width: 1600, height: 900, label: '1600 × 900 · HD+' },
  { id: '1920x1080', width: 1920, height: 1080, label: '1920 × 1080 · FHD' },
  { id: '2560x1440', width: 2560, height: 1440, label: '2560 × 1440 · QHD' },
] as const;

export const SETTINGS_KEY = 'multi-terminal.settings.v1';
export const defaults: Settings = {
  fontFamily: 'Cascadia Mono',
  fontSize: 15,
  lineHeight: 1.25,
  scrollback: 5000,
  cursorBlink: true,
  windowSize: '1440x900',
};

export function normalizeSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? (value as Partial<Settings>) : {};
  const number = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    fontFamily:
      typeof raw.fontFamily === 'string' && raw.fontFamily.trim()
        ? raw.fontFamily.trim().slice(0, 120)
        : defaults.fontFamily,
    fontSize: Math.round(number(raw.fontSize, defaults.fontSize, 10, 32)),
    lineHeight: number(raw.lineHeight, defaults.lineHeight, 1, 1.8),
    scrollback: Math.round(number(raw.scrollback, defaults.scrollback, 1000, 20000)),
    cursorBlink: typeof raw.cursorBlink === 'boolean' ? raw.cursorBlink : defaults.cursorBlink,
    windowSize: windowSizes.some((size) => size.id === raw.windowSize)
      ? raw.windowSize!
      : defaults.windowSize,
  };
}

export function loadSettings(): Settings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'));
  } catch {
    return { ...defaults };
  }
}

export function terminalFont(family: string): string {
  // A quoted family cannot inject additional CSS values. Korean glyphs fall
  // back to installed CJK fonts while keeping xterm's double-width cell layout.
  const safe = family.replace(/["\\\r\n]/g, '');
  return `"${safe}", "Cascadia Mono", Consolas, "D2Coding", "Noto Sans Mono CJK KR", "Malgun Gothic", monospace`;
}
