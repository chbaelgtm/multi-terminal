import { describe, expect, it } from 'vitest';
import { defaults, normalizeSettings, terminalFont } from './settings';

describe('persisted settings', () => {
  it('recovers from missing or malformed values', () => {
    expect(normalizeSettings(null)).toEqual(defaults);
    expect(normalizeSettings({ fontSize: 'oops', fontFamily: ' ', cursorBlink: 'true' })).toEqual(
      defaults,
    );
  });
  it('bounds expensive rendering settings and preserves Korean font names', () => {
    expect(
      normalizeSettings({
        fontSize: 300,
        lineHeight: -1,
        scrollback: Infinity,
        fontFamily: '나눔고딕코딩',
        cursorBlink: false,
      }),
    ).toEqual({
      ...defaults,
      fontSize: 32,
      lineHeight: 1,
      fontFamily: '나눔고딕코딩',
      cursorBlink: false,
    });
    expect(normalizeSettings({ fontSize: 1, scrollback: 100000 }).scrollback).toBe(20000);
  });
  it('quotes a font family and keeps CJK fallbacks', () => {
    expect(terminalFont('D2Coding')).toContain('"D2Coding"');
    expect(terminalFont('bad"\\\nfont')).toContain('"badfont"');
    expect(terminalFont('Consolas')).toContain('Malgun Gothic');
  });
});
