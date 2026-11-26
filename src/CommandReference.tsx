import { useEffect, useRef, useState, type RefObject } from 'react';
import { BookOpen, Check, Copy, Search, X } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
  commandCategories,
  commands,
  filterCommands,
  type CommandCategory,
  type CommandShell,
} from './commands';

export function CommandReference({
  open,
  initialShell,
  onClose,
  trigger,
}: {
  open: boolean;
  initialShell: CommandShell;
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [shell, setShell] = useState<CommandShell>(initialShell);
  const [category, setCategory] = useState<CommandCategory | '전체'>('전체');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const [notice, setNotice] = useState('');
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (open) {
      setShell(initialShell);
      setQuery('');
      setCategory('전체');
      setCopied('');
      setNotice('');
      dialog.current?.showModal();
      search.current?.focus();
    } else if (dialog.current?.open) dialog.current.close();
  }, [open, initialShell]);
  useEffect(() => () => clearTimeout(timeout.current), []);
  const results = filterCommands(shell, category, query);
  const copy = async (id: string, example: string) => {
    try {
      await writeText(example);
      setCopied(id);
      setNotice('명령어를 복사했습니다. 사용할 터미널에 붙여넣으세요.');
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(''), 1800);
    } catch (error) {
      setNotice(`복사하지 못했습니다: ${String(error)}`);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="commands-dialog"
      aria-labelledby="commands-title"
      onCancel={onClose}
      onClose={() => {
        onClose();
        if (
          document.activeElement === document.body ||
          dialog.current?.contains(document.activeElement)
        )
          trigger.current?.focus();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="commands-content">
        <header className="commands-header">
          <div>
            <span className="eyebrow">QUICK REFERENCE</span>
            <h2 id="commands-title">
              <BookOpen size={21} /> 명령어 모음
            </h2>
            <p>자주 쓰는 명령어를 찾아보고, 필요한 예시를 복사하세요.</p>
          </div>
          <button aria-label="명령어 모음 닫기" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="commands-controls">
          <div className="command-tabs" role="tablist" aria-label="명령어 셸">
            {(['powershell', 'cmd'] as const).map((value) => (
              <button
                key={value}
                role="tab"
                id={`command-tab-${value}`}
                aria-controls="command-results"
                aria-selected={shell === value}
                tabIndex={shell === value ? 0 : -1}
                onClick={() => setShell(value)}
                onKeyDown={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const next =
                      event.key === 'Home'
                        ? 'powershell'
                        : event.key === 'End'
                          ? 'cmd'
                          : shell === 'powershell'
                            ? 'cmd'
                            : 'powershell';
                    setShell(next);
                    document.getElementById(`command-tab-${next}`)?.focus();
                  }
                }}
              >
                {value === 'powershell' ? 'PowerShell' : 'CMD'}
                <span>{commands.filter((command) => command.shell === value).length}</span>
              </button>
            ))}
          </div>
          <div className="command-search">
            <Search size={17} />
            <input
              ref={search}
              aria-label="명령어 검색"
              placeholder="명령어, 설명, 별칭 검색 · 예: 로그, 포트, dir"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                aria-label="명령어 검색 지우기"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <div className="command-categories" aria-label="명령어 분류">
            {(['전체', ...commandCategories] as const).map((value) => (
              <button
                key={value}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="command-result-summary">
          <span aria-live="polite">{results.length}개 명령어</span>
          <span>
            {shell === 'powershell'
              ? 'Windows PowerShell 5.1 / PowerShell 7'
              : 'Windows 명령 프롬프트'}
          </span>
        </div>
        <div
          id="command-results"
          className="command-results"
          role="tabpanel"
          aria-labelledby={`command-tab-${shell}`}
          tabIndex={0}
        >
          {results.length ? (
            <div className="command-cards">
              {results.map((command) => (
                <article
                  className="command-card"
                  key={command.id}
                  aria-labelledby={`title-${command.id}`}
                >
                  <div className="command-card-heading">
                    <div>
                      <span className="command-category-label">{command.category}</span>
                      <h3 id={`title-${command.id}`}>{command.title}</h3>
                    </div>
                    <button
                      className={`command-copy ${copied === command.id ? 'copied' : ''}`}
                      aria-label={`${command.title} 명령어 복사`}
                      title="예시 복사"
                      onClick={() => void copy(command.id, command.example)}
                    >
                      {copied === command.id ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                  </div>
                  <p>{command.description}</p>
                  <pre>
                    <code>{command.example}</code>
                  </pre>
                  {command.aliases && (
                    <div className="command-aliases">
                      {shell === 'powershell' &&
                      command.aliases.some((alias) => ['grep', 'tail'].includes(alias))
                        ? '검색 키워드'
                        : '별칭·관련 명령'}
                      <span>{command.aliases.join(' · ')}</span>
                    </div>
                  )}
                  {command.note && <p className="command-note">{command.note}</p>}
                </article>
              ))}
            </div>
          ) : (
            <div className="command-empty">
              <Search size={28} />
              <h3>일치하는 명령어가 없습니다.</h3>
              <p>다른 검색어나 분류로 찾아보세요.</p>
              <button
                onClick={() => {
                  setQuery('');
                  setCategory('전체');
                  search.current?.focus();
                }}
              >
                전체 명령어 보기
              </button>
            </div>
          )}
        </div>
        <footer className="commands-footer">
          <span role="status">
            {notice || '경로, 파일 이름, 포트 번호는 작업 환경에 맞게 바꿔 사용하세요.'}
          </span>
          <span>
            <kbd>Esc</kbd> 닫기
          </span>
        </footer>
      </div>
    </dialog>
  );
}
