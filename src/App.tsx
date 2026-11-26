import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import {
  ChevronDown,
  Check,
  ClipboardPaste,
  Copy,
  Eraser,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  TerminalSquare,
  X,
  BookOpen,
} from 'lucide-react';
import {
  defaults,
  loadSettings,
  normalizeSettings,
  SETTINGS_KEY,
  windowSizes,
  type Settings,
} from './settings';
import { applyWindowSize } from './window';
import { TerminalController, type PaneState, type Shell } from './terminal';
import { CommandReference } from './CommandReference';

type Pane = { key: string; number: number; shell: Shell; cwd: string };
const windows = navigator.userAgent.includes('Windows');
const shells: { id: Shell; name: string }[] = windows
  ? [
      { id: 'powershell', name: 'Windows PowerShell' },
      { id: 'pwsh', name: 'PowerShell 7' },
      { id: 'cmd', name: 'Command Prompt' },
      { id: 'wsl', name: 'WSL' },
    ]
  : [
      { id: 'default', name: '기본 셸' },
      { id: 'bash', name: 'Bash' },
      { id: 'zsh', name: 'Zsh' },
    ];
const newPane = (number: number, shell: Shell, cwd = ''): Pane => ({
  key: crypto.randomUUID(),
  number,
  shell,
  cwd,
});

function TerminalPane({
  pane,
  settings,
  active,
  focus,
  register,
  notify,
  close,
}: {
  pane: Pane;
  settings: Settings;
  active: boolean;
  focus: () => void;
  register: (key: string, controller?: TerminalController) => void;
  notify: (message: string) => void;
  close: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalController | null>(null);
  const [state, setState] = useState<PaneState>({ status: 'starting' });
  const [closing, setClosing] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    setState({ status: 'starting' });
    const term = new TerminalController(
      host.current!,
      settings,
      pane.shell,
      pane.cwd,
      (next) => setState((prev) => ({ ...prev, ...next })),
      notify,
    );
    controller.current = term;
    register(pane.key, term);
    return () => {
      register(pane.key);
      controller.current = null;
      void term.dispose().catch((error) => notify(String(error)));
    };
    // Session lifetime follows pane identity; appearance updates below never recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
  useEffect(() => {
    controller.current?.applySettings(settings);
  }, [settings]);
  useEffect(() => {
    if (active) controller.current?.focus();
  }, [active]);
  const remove = async () => {
    setClosing(true);
    try {
      await controller.current?.dispose();
      close();
    } catch (error) {
      notify(String(error));
      setClosing(false);
    }
  };
  const status = { starting: '연결 중', running: '실행 중', exited: '종료됨', error: '연결 실패' }[
    state.status
  ];
  return (
    <section
      className={`terminal-pane ${active ? 'active' : ''}`}
      aria-label={`터미널 ${pane.number}`}
      onFocusCapture={focus}
      onPointerDown={focus}
    >
      <header className="pane-header">
        <span className="pane-number">{String(pane.number).padStart(2, '0')}</span>
        <span className="pane-title" title={state.title || state.info?.cwd}>
          {state.title || shells.find((s) => s.id === pane.shell)?.name}
        </span>
        <span className={`status-dot ${state.status}`} title={status} />
        <span className="pane-status">{status}</span>
        <div className="pane-actions">
          {(state.status === 'exited' || state.status === 'error') && (
            <button
              aria-label={`터미널 ${pane.number} 다시 시작`}
              title="다시 시작"
              onClick={() => setGeneration((v) => v + 1)}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button
            aria-label={`터미널 ${pane.number} 복사`}
            title="선택 영역 복사 · Ctrl+Shift+C"
            onClick={() => void controller.current?.copy()}
          >
            <Copy size={14} />
          </button>
          <button
            aria-label={`터미널 ${pane.number} 붙여넣기`}
            title="붙여넣기 · Ctrl+Shift+V"
            onClick={() => void controller.current?.paste()}
          >
            <ClipboardPaste size={14} />
          </button>
          <button
            aria-label={`터미널 ${pane.number} 화면 지우기`}
            title="스크롤 기록 지우기"
            onClick={() => controller.current?.clear()}
          >
            <Eraser size={14} />
          </button>
          <button
            className="close-pane"
            aria-label={`터미널 ${pane.number} 닫기`}
            title="프로세스 종료 및 패널 닫기"
            disabled={closing}
            onClick={() => void remove()}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="terminal-host" ref={host} />
      <footer className="pane-footer">
        <span>{state.info?.cwd || pane.cwd || '홈 디렉터리'}</span>
        <span>{state.info?.pid ? `PID ${state.info.pid}` : '—'}</span>
      </footer>
    </section>
  );
}

export function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [panes, setPanes] = useState<Pane[]>(() => [newPane(1, shells[0].id)]);
  const [active, setActive] = useState<string | null>(null);
  const [selectedShell, setShell] = useState<Shell>(shells[0].id);
  const [cwd, setCwd] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const commandsButton = useRef<HTMLButtonElement>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [windowSizeNote, setWindowSizeNote] = useState('');
  const windowSizeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [splitX, setSplitX] = useState(50);
  const [splitY, setSplitY] = useState(50);
  const controllers = useRef(new Map<string, TerminalController>());
  const nextNumber = useRef(2);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const grid = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const notify = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(''), 4500);
  }, []);
  const register = useCallback((key: string, controller?: TerminalController) => {
    if (controller) controllers.current.set(key, controller);
    else controllers.current.delete(key);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      notify('설정을 저장하지 못했습니다. 현재 창에는 적용됩니다.');
    }
  }, [settings, notify]);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    windowSizeQueue.current = windowSizeQueue.current
      .then(async () => {
        if (cancelled) return;
        const result = await applyWindowSize(settings.windowSize);
        if (!cancelled)
          setWindowSizeNote(
            result.adjusted
              ? `현재 화면에 맞춰 ${result.width} × ${result.height} 크기로 적용했습니다.`
              : '',
          );
      })
      .catch((error) => {
        if (!cancelled) notify(`창 크기 변경 실패: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.windowSize, notify]);
  useEffect(() => {
    void invoke<string[]>('list_fonts')
      .then(setFonts)
      .catch(() => {});
    return () => clearTimeout(toastTimer.current);
  }, []);
  useEffect(() => {
    // Only the explicitly opted-in development smoke runner gets a test bridge.
    // Vite removes this branch from normal production builds.
    if (import.meta.env.DEV && import.meta.env.VITE_TERMINAL_E2E === '1') {
      Object.assign(window, {
        __terminalTest: { controllers: controllers.current, invoke, Channel },
      });
      return () => {
        delete (window as unknown as Record<string, unknown>).__terminalTest;
      };
    }
  }, []);
  useEffect(() => {
    if (showSettings) settingsDialog.current?.showModal();
    else if (settingsDialog.current?.open) settingsDialog.current.close();
  }, [showSettings]);
  const add = useCallback(() => {
    setPanes((previous) => {
      if (previous.length >= 4) return previous;
      return [...previous, newPane(nextNumber.current++, selectedShell, cwd)];
    });
  }, [selectedShell, cwd]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        settingsDialog.current?.open ||
        showCommands
      )
        return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        add();
      }
      if (event.altKey && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        const pane = panes[Number(event.key) - 1];
        if (pane) {
          setActive(pane.key);
          controllers.current.get(pane.key)?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panes, add, showCommands]);
  const update = (patch: Partial<Settings>) =>
    setSettings((prev) => normalizeSettings({ ...prev, ...patch }));
  const close = (key: string) => {
    setPanes((prev) => prev.filter((pane) => pane.key !== key));
    setActive((prev) => (prev === key ? null : prev));
  };
  const moveSplit = (axis: 'x' | 'y', event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const bounds = grid.current!.getBoundingClientRect();
      const value =
        axis === 'x'
          ? ((e.clientX - bounds.left) / bounds.width) * 100
          : ((e.clientY - bounds.top) / bounds.height) * 100;
      (axis === 'x' ? setSplitX : setSplitY)(Math.min(75, Math.max(25, value)));
    };
    const target = event.currentTarget;
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon">
            <TerminalSquare size={22} />
          </div>
          <div>
            <h1>
              Multi Terminal<span className="version">/ 01</span>
            </h1>
            <p>하나의 창, 이어지는 작업.</p>
          </div>
        </div>
        <div className="header-right">
          <span className="workspace-label">
            <span className="online-dot" /> LOCAL WORKSPACE
          </span>
          <div className="header-actions">
            <button
              ref={commandsButton}
              className={`settings-button ${showCommands ? 'selected' : ''}`}
              onClick={() => setShowCommands(true)}
            >
              <BookOpen size={16} /> 명령어 모음
            </button>
            <button
              ref={settingsButton}
              className={`settings-button ${showSettings ? 'selected' : ''}`}
              onClick={() => setShowSettings(true)}
            >
              <Settings2 size={16} /> 화면 설정
            </button>
          </div>
        </div>
      </header>
      <main>
        <div className="workspace-toolbar">
          <div className="workspace-heading">
            <span className="eyebrow">WORKSPACE</span>
            <h2>
              터미널{' '}
              <span>
                {panes.length}
                <span className="muted"> / 4</span>
              </span>
            </h2>
          </div>
          <div className="new-session-controls">
            <div className="shell-select">
              <TerminalSquare size={15} />
              <select
                aria-label="새 터미널 셸"
                value={selectedShell}
                onChange={(e) => setShell(e.target.value as Shell)}
              >
                {shells.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </div>
            <input
              className="cwd-input"
              aria-label="새 터미널 작업 폴더"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="작업 폴더 · 기본: 홈"
              title="다음에 추가할 터미널의 작업 폴더 절대 경로"
            />
            <button
              className="add-button"
              disabled={panes.length >= 4}
              title="새 터미널 · Ctrl+Shift+T"
              onClick={add}
            >
              <Plus size={16} /> 터미널 추가
            </button>
          </div>
        </div>
        <div
          className={`terminal-grid count-${panes.length}`}
          ref={grid}
          style={{ '--split-x': `${splitX}%`, '--split-y': `${splitY}%` } as CSSProperties}
        >
          {panes.map((pane) => (
            <TerminalPane
              key={pane.key}
              pane={pane}
              settings={settings}
              active={active === pane.key}
              focus={() => setActive(pane.key)}
              register={register}
              notify={notify}
              close={() => close(pane.key)}
            />
          ))}
          {panes.length >= 2 && (
            <div
              className="splitter vertical"
              role="separator"
              aria-label="좌우 패널 크기"
              aria-orientation="vertical"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(splitX)}
              tabIndex={0}
              onPointerDown={(e) => moveSplit('x', e)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  setSplitX((v) =>
                    Math.max(25, Math.min(75, v + (e.key === 'ArrowLeft' ? -2 : 2))),
                  );
                }
              }}
            />
          )}
          {panes.length >= 3 && (
            <div
              className="splitter horizontal"
              role="separator"
              aria-label="상하 패널 크기"
              aria-orientation="horizontal"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(splitY)}
              tabIndex={0}
              onPointerDown={(e) => moveSplit('y', e)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSplitY((v) => Math.max(25, Math.min(75, v + (e.key === 'ArrowUp' ? -2 : 2))));
                }
              }}
            />
          )}
          {panes.length === 0 && (
            <div className="empty-state">
              <TerminalSquare size={38} strokeWidth={1} />
              <h2>새로운 작업을 시작하세요.</h2>
              <p>독립적인 터미널을 최대 4개까지 나란히.</p>
              <button className="add-button" onClick={add}>
                <Plus size={16} /> 터미널 열기
              </button>
            </div>
          )}
        </div>
      </main>
      <footer className="app-footer">
        <div>
          <span className="online-dot" /> Tauri + Rust <span className="footer-divider">/</span>
          <span>
            {settings.fontFamily} · {settings.fontSize}px
          </span>
        </div>
        <div className="shortcut-hints">
          <span>
            <kbd>Alt</kbd> + <kbd>1–4</kbd> 패널 이동
          </span>
          <span>
            <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>C / V</kbd> 복사 / 붙여넣기
          </span>
        </div>
      </footer>
      {message && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{message}</span>
          <button aria-label="알림 닫기" onClick={() => setMessage('')}>
            <X size={14} />
          </button>
        </div>
      )}
      <CommandReference
        open={showCommands}
        initialShell={
          (panes.find((pane) => pane.key === active)?.shell ?? selectedShell) === 'cmd'
            ? 'cmd'
            : 'powershell'
        }
        onClose={() => setShowCommands(false)}
        trigger={commandsButton}
      />
      <dialog
        ref={settingsDialog}
        aria-labelledby="settings-title"
        className="settings-dialog"
        onCancel={() => setShowSettings(false)}
        onClose={() => {
          setShowSettings(false);
          if (
            document.activeElement === document.body ||
            settingsDialog.current?.contains(document.activeElement)
          ) {
            settingsButton.current?.focus();
          }
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setShowSettings(false);
        }}
      >
        <div className="dialog-content">
          <header>
            <div>
              <span className="eyebrow">MAKE IT YOURS</span>
              <h2 id="settings-title">편안한 작업 화면</h2>
            </div>
            <button aria-label="설정 닫기" onClick={() => setShowSettings(false)}>
              <X size={20} />
            </button>
          </header>
          <p className="settings-intro">모든 터미널에 바로 적용하고, 다음 실행에도 기억해요.</p>
          <div className="setting-row">
            <label htmlFor="window-size">창 크기</label>
            <select
              id="window-size"
              value={settings.windowSize}
              onChange={(event) => update({ windowSize: event.target.value })}
            >
              {windowSizes.map((size) => (
                <option key={size.id} value={size.id}>
                  {size.label}
                </option>
              ))}
            </select>
          </div>
          <p className="field-note">
            Windows 배율을 반영하며, 화면보다 크면 작업 영역에 맞춥니다.
            {windowSizeNote && (
              <>
                <br />
                {windowSizeNote}
              </>
            )}
          </p>
          <label className="setting-label" htmlFor="font-family">
            터미널 글꼴 <span>설치된 글꼴 선택 또는 직접 입력</span>
          </label>
          <input
            id="font-family"
            list="system-fonts"
            value={settings.fontFamily}
            onChange={(e) => update({ fontFamily: e.target.value })}
          />
          <datalist id="system-fonts">
            {Array.from(new Set(['Cascadia Mono', 'Consolas', 'D2Coding', ...fonts])).map(
              (font) => (
                <option key={font} value={font} />
              ),
            )}
          </datalist>
          <p className="field-note">
            고정폭 글꼴을 권장해요. 한글은 설치된 한글 글꼴로 보완합니다.
          </p>
          <div className="setting-row">
            <label htmlFor="font-size">글자 크기</label>
            <div className="number-stepper">
              <button
                aria-label="글자 크기 줄이기"
                disabled={settings.fontSize <= 10}
                onClick={() => update({ fontSize: settings.fontSize - 1 })}
              >
                <Minus size={14} />
              </button>
              <input
                id="font-size"
                type="number"
                min={10}
                max={32}
                value={settings.fontSize}
                onChange={(e) => update({ fontSize: Number(e.target.value) })}
              />
              <span>px</span>
              <button
                aria-label="글자 크기 늘리기"
                disabled={settings.fontSize >= 32}
                onClick={() => update({ fontSize: settings.fontSize + 1 })}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
          <div className="setting-row">
            <label htmlFor="line-height">줄 간격</label>
            <select
              id="line-height"
              value={settings.lineHeight}
              onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            >
              {[1, 1.1, 1.25, 1.4, 1.6, 1.8].map((v) => (
                <option key={v} value={v}>
                  {v}배
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="scrollback">스크롤 기록</label>
            <select
              id="scrollback"
              value={settings.scrollback}
              onChange={(e) => update({ scrollback: Number(e.target.value) })}
            >
              {[1000, 5000, 10000, 20000].map((v) => (
                <option key={v} value={v}>
                  {v.toLocaleString()}줄
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="cursor-blink">커서 깜빡임</label>
            <input
              id="cursor-blink"
              type="checkbox"
              role="switch"
              checked={settings.cursorBlink}
              onChange={(e) => update({ cursorBlink: e.target.checked })}
            />
          </div>
          <div
            className="font-preview"
            style={{
              fontFamily: `"${settings.fontFamily.replace(/["\\]/g, '')}", monospace`,
              fontSize: settings.fontSize,
              lineHeight: settings.lineHeight,
            }}
          >
            <span className="preview-comment"># 나에게 맞는 터미널</span>
            <br />
            <span className="preview-prompt">❯</span> echo "안녕하세요, Hello!"
            <br />
            <span>0123456789 ABCD 가나다라</span>
          </div>
          <footer>
            <button className="reset-button" onClick={() => setSettings({ ...defaults })}>
              <RotateCcw size={14} /> 기본값 복원
            </button>
            <span>
              <Check size={13} /> 자동 저장
            </span>
            <button className="done-button" onClick={() => setShowSettings(false)}>
              완료
            </button>
          </footer>
        </div>
      </dialog>
    </div>
  );
}
