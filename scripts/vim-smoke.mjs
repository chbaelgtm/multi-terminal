// Opt-in: this suite needs console Vim (Git for Windows includes it).
process.env.TERMINAL_VIM_TEST = '1';
await import('./desktop-smoke.mjs');
