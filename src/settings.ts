export type Settings = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorBlink: boolean;
};

export const SETTINGS_KEY = 'multi-terminal.settings.v1';
export const defaults: Settings = {
  fontFamily: 'Cascadia Mono',
  fontSize: 15,
  lineHeight: 1.25,
  scrollback: 5000,
  cursorBlink: true,
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
