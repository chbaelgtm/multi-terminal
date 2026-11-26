import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { terminalFont, type Settings } from './settings';

export type Shell = 'powershell' | 'pwsh' | 'cmd' | 'wsl' | 'default' | 'bash' | 'zsh';
export type SessionInfo = { id: string; shell: string; cwd: string; pid: number | null };
type TerminalEvent =
  | { event: 'data'; bytes: number[] }
  | { event: 'exit'; code: number | null }
  | { event: 'error'; message: string };
export type PaneState = {
  status: 'starting' | 'running' | 'exited' | 'error';
  info?: SessionInfo;
  title?: string;
  code?: number | null;
};

export class TerminalController {
  readonly terminal: Terminal;
  private fitAddon = new FitAddon();
  private remoteId?: string;
  private starting = true;
  private earlyInput: Uint8Array[] = [];
  private disposed = false;
  private exited = false;
  private observer: ResizeObserver;
  private ackBytes = 0;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private pasteCapture?: Uint8Array[];
  private resizeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    container: HTMLElement,
    settings: Settings,
    shell: Shell,
    cwd: string,
    private onState: (state: PaneState) => void,
    private notify: (message: string) => void,
  ) {
    this.terminal = new Terminal({
      fontFamily: terminalFont(settings.fontFamily),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursorBlink,
      cursorStyle: 'bar',
      allowProposedApi: true,
      rightClickSelectsWord: true,
      theme: {
        background: '#12161c',
        foreground: '#d6dde7',
        cursor: '#b6f09c',
        selectionBackground: '#44614f99',
        black: '#242a33',
        red: '#f28b82',
        green: '#b6f09c',
        yellow: '#e9c779',
        blue: '#83b5fa',
        magenta: '#c4a7e7',
        cyan: '#82d8cd',
        white: '#d6dde7',
        brightBlack: '#748196',
        brightRed: '#ffaaa0',
        brightGreen: '#c9ffb0',
        brightYellow: '#ffe09a',
        brightBlue: '#a2cbff',
        brightMagenta: '#dfc4ff',
        brightCyan: '#a6f6e8',
        brightWhite: '#f4f6fa',
      },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.terminal.open(container);
    this.fit();
    this.terminal.textarea?.setAttribute('aria-label', '터미널 명령 입력');
    this.terminal.attachCustomKeyEventHandler((event) => {
      // Let xterm's own composition handler manage the Korean IME lifecycle.
      if (event.isComposing || event.keyCode === 229) return true;
      const key = event.key.toLowerCase();
      const copy = (event.ctrlKey || event.metaKey) && event.shiftKey && key === 'c';
      const paste =
        ((event.ctrlKey || event.metaKey) &&
          key === 'v' &&
          (event.shiftKey || event.metaKey || this.terminal.buffer.active.type !== 'alternate')) ||
        (event.shiftKey && key === 'insert');
      if (copy || paste) {
        event.preventDefault();
        if (event.type === 'keydown') void (copy ? this.copy() : this.paste());
        return false;
      }
      return true;
    });
    this.terminal.onData((data) => this.write(new TextEncoder().encode(data)));
    this.terminal.onBinary((data) => this.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
    this.terminal.onTitleChange((title) => this.onState({ status: 'running', title }));
    this.terminal.onResize(() => this.scheduleResize());
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(container);
    void document.fonts.ready.then(() => {
      if (!this.disposed) this.fit();
    });
    void this.start(shell, cwd);
  }

  private async start(shell: Shell, cwd: string) {
    if (!isTauri()) {
      this.starting = false;
      this.onState({ status: 'error' });
      this.terminal.writeln(
        '\x1b[33m데스크톱 앱에서 터미널을 실행하세요.\x1b[0m\r\n개발 실행: npm run desktop',
      );
      return;
    }
    const events = new Channel<TerminalEvent>();
    events.onmessage = (event) => {
      if (this.disposed) return;
      if (event.event === 'data') {
        const bytes = new Uint8Array(event.bytes);
        this.terminal.write(bytes, () => {
          if (this.disposed) return;
          this.ackBytes += bytes.length;
          if (!this.ackTimer) this.ackTimer = setTimeout(() => this.flushAck(), 16);
        });
      } else if (event.event === 'exit') {
        this.exited = true;
        this.terminal.options.disableStdin = true;
        this.onState({ status: 'exited', code: event.code });
        this.terminal.writeln(
          `\r\n\x1b[90m[프로세스 종료 · 코드 ${event.code ?? '알 수 없음'}]\x1b[0m`,
        );
      } else {
        this.notify(event.message);
        this.onState({ status: 'error' });
      }
    };
    try {
      const info = await invoke<SessionInfo>('create_terminal', {
        shell,
        cwd: cwd.trim() || null,
        rows: this.terminal.rows,
        cols: this.terminal.cols,
        onEvent: events,
      });
      this.remoteId = info.id;
      this.starting = false;
      if (this.disposed) {
        await invoke('close_terminal', { id: info.id });
        return;
      }
      // ConPTY can request a cursor-position reply before create_terminal's
      // promise resolves. Replay that reply (and any early keystrokes) first.
      for (const bytes of this.earlyInput.splice(0)) this.write(bytes);
      this.onState({ status: this.exited ? 'exited' : 'running', info });
      this.flushAck();
      this.scheduleResize();
      this.focus();
    } catch (error) {
      this.starting = false;
      this.earlyInput = [];
      if (this.disposed) return;
      this.onState({ status: 'error' });
      this.terminal.writeln(`\r\n\x1b[31m${String(error)}\x1b[0m`);
      this.notify(String(error));
    }
  }

  private flushAck() {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (!this.remoteId || !this.ackBytes || this.disposed) return;
    const count = this.ackBytes;
    this.ackBytes = 0;
    void invoke('ack_terminal', { id: this.remoteId, count }).catch(() => {});
  }

  private write(bytes: Uint8Array) {
    if (this.pasteCapture) {
      this.pasteCapture.push(bytes);
      return;
    }
    if (this.disposed || this.exited) return;
    if (!this.remoteId) {
      if (this.starting) this.earlyInput.push(bytes);
      return;
    }
    // Serialize input IPC so rapid typing and large pastes preserve byte order.
    this.queue = this.queue
      .then(() => this.sendBytes(bytes))
      .catch((error) => {
        if (!this.disposed && !this.exited) this.notify(String(error));
      });
  }

  private async sendBytes(bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      if (!this.remoteId || this.disposed || this.exited) return;
      await invoke('write_terminal', {
        id: this.remoteId,
        bytes: Array.from(bytes.subarray(offset, offset + 16384)),
      });
    }
  }

  private scheduleResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (!this.remoteId || this.disposed || this.exited) return;
      const args = { id: this.remoteId, rows: this.terminal.rows, cols: this.terminal.cols };
      this.resizeQueue = this.resizeQueue
        .then(() => {
          if (!this.disposed && !this.exited) return invoke('resize_terminal', args);
        })
        .catch((error) => {
          if (!this.disposed && !this.exited) this.notify(String(error));
        });
    }, 60);
  }

  fit() {
    if (this.disposed) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* Container may be between layouts. */
    }
  }

  applySettings(settings: Settings) {
    this.terminal.options.fontFamily = terminalFont(settings.fontFamily);
    this.terminal.options.fontSize = settings.fontSize;
    this.terminal.options.lineHeight = settings.lineHeight;
    this.terminal.options.scrollback = settings.scrollback;
    this.terminal.options.cursorBlink = settings.cursorBlink;
    this.fit();
    void document.fonts.ready.then(() => this.fit());
  }

  focus() {
    if (!this.disposed) this.terminal.focus();
  }

  async copy() {
    this.focus();
    const text = this.terminal.getSelection();
    if (!text) {
      this.notify('복사할 텍스트를 터미널에서 드래그해 선택하세요.');
      return;
    }
    try {
      await writeText(text);
      this.notify('선택한 텍스트를 복사했습니다.');
    } catch (error) {
      this.notify(`복사 실패: ${String(error)}`);
    }
    this.focus();
  }

  paste(): Promise<unknown> {
    this.focus();
    // Reading the native clipboard is async. Reserve its place in the input
    // queue before reading so a quick Enter cannot overtake the pasted text.
    this.queue = this.queue
      .then(async () => {
        if (!this.remoteId || this.exited) {
          this.notify('실행 중인 터미널에 붙여넣을 수 있습니다.');
          return;
        }
        const text = await readText();
        if (this.disposed) return;
        const captured: Uint8Array[] = [];
        this.pasteCapture = captured;
        try {
          if (text) this.terminal.paste(text);
        } finally {
          this.pasteCapture = undefined;
        }
        for (const bytes of captured) await this.sendBytes(bytes);
        this.focus();
      })
      .catch((error) => {
        if (!this.disposed) this.notify(`붙여넣기 실패: ${String(error)}`);
      });
    return this.queue;
  }

  clear() {
    this.terminal.clear();
    this.focus();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    clearTimeout(this.ackTimer);
    clearTimeout(this.resizeTimer);
    this.terminal.dispose();
    if (this.remoteId) await invoke('close_terminal', { id: this.remoteId });
  }
}
