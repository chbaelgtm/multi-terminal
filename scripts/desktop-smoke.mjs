import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// This tests the actual Tauri WebView2 + IPC + ConPTY, never a mock backend.
// The debugging port and test bridge are enabled only in this dev process.
if (process.platform !== 'win32')
  throw new Error('The desktop smoke suite currently targets Windows WebView2.');
const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.TERMINAL_CDP_PORT || 9223);
const attach = process.env.TERMINAL_ATTACH === '1';
await mkdir(path.join(root, 'test-results'), { recursive: true });
let child;
if (!attach) {
  const log = createWriteStream(path.join(root, 'test-results', 'desktop-dev.log'));
  child = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'dev', '--no-watch'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      VITE_TERMINAL_E2E: '1',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
}
let browser, page;
let previousClipboard, previousSettings;
const processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const checks = [];
const pass = (label) => {
  checks.push(label);
  console.log(`PASS ${label}`);
};
const bridge = (fn, arg) => page.evaluate(fn, arg);
const buffer = (index) =>
  bridge((index) => {
    const term = [...window.__terminalTest.controllers.values()][index].terminal;
    const buffer = term.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true) || '',
    ).join('\n');
  }, index);
const send = (index, text) =>
  bridge(
    ({ index, text }) => {
      const ctrl = [...window.__terminalTest.controllers.values()][index];
      ctrl.terminal.paste(text);
    },
    { index, text },
  );
const command = async (index, text) => {
  await send(index, text);
  await page.locator('.terminal-pane').nth(index).locator('textarea').focus();
  await page.keyboard.press('Enter');
};
const pids = () =>
  page
    .locator('.pane-footer')
    .allTextContents()
    .then((texts) => texts.map((text) => Number(text.match(/PID (\d+)/)?.[1])).filter(Boolean));

try {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child && child.exitCode !== null)
      throw new Error(`Tauri dev exited (${child.exitCode}); see test-results/desktop-dev.log`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await delay(1000);
    }
  }
  assert(browser, 'WebView2 debugging endpoint did not start');
  for (let attempt = 0; attempt < 60; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes('1420'));
    if (page) break;
    await delay(500);
  }
  assert(page, 'Tauri WebView page missing');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.__terminalTest?.controllers.size === 1);
  await expect(page.locator('.pane-status').first()).toHaveText('실행 중');
  previousClipboard = await bridge(() =>
    window.__terminalTest.invoke('plugin:clipboard-manager|read_text'),
  );
  previousSettings = await page.evaluate(() => localStorage.getItem('multi-terminal.settings.v1'));
  pass('actual Tauri window starts a live PTY');

  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: '터미널 추가', exact: true }).click();
  await expect(page.locator('.terminal-pane')).toHaveCount(4);
  await expect(page.locator('.pane-status', { hasText: '실행 중' })).toHaveCount(4);
  await expect(page.getByRole('button', { name: '터미널 추가', exact: true })).toBeDisabled();
  const limit = await bridge(async () => {
    const { invoke, Channel } = window.__terminalTest;
    try {
      await invoke('create_terminal', {
        shell: 'powershell',
        cwd: null,
        rows: 24,
        cols: 80,
        onEvent: new Channel(),
      });
      return 'unexpected success';
    } catch (error) {
      return String(error);
    }
  });
  assert.match(limit, /최대 4개/);
  pass('four live PTYs; UI and backend both reject a fifth');

  for (let i = 0; i < 4; i++) {
    await command(i, `$mtPane='pane${i}'; Write-Output ('ISOLATION_' + $mtPane)`);
    await expect.poll(() => buffer(i), { timeout: 15000 }).toContain(`ISOLATION_pane${i}`);
    for (let j = 0; j < 4; j++)
      if (j !== i) assert(!(await buffer(i)).includes(`ISOLATION_pane${j}`));
  }
  pass('four shells keep independent variables and output streams');

  const koreanCommand = "Write-Output ('CLIP_' + '안녕하세요 한글 테스트 ✓')";
  await bridge(
    (text) => window.__terminalTest.invoke('plugin:clipboard-manager|write_text', { text }),
    koreanCommand,
  );
  await page.getByRole('button', { name: '터미널 1 붙여넣기', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect.poll(() => buffer(0), { timeout: 15000 }).toContain('CLIP_안녕하세요 한글 테스트 ✓');
  await bridge(() => [...window.__terminalTest.controllers.values()][0].terminal.selectAll());
  await page.getByRole('button', { name: '터미널 1 복사', exact: true }).click();
  const copied = await bridge(() =>
    window.__terminalTest.invoke('plugin:clipboard-manager|read_text'),
  );
  assert(copied.includes('CLIP_안녕하세요 한글 테스트 ✓'));
  pass('native clipboard buttons roundtrip Korean text');

  await bridge(
    (text) => window.__terminalTest.invoke('plugin:clipboard-manager|write_text', { text }),
    "Write-Output ('KEY_' + '복사붙여넣기')",
  );
  await page.locator('.terminal-pane').first().locator('textarea').focus();
  await page.keyboard.press('Control+Shift+V');
  await page.keyboard.press('Enter');
  await expect.poll(() => buffer(0)).toContain('KEY_복사붙여넣기');
  await bridge(() => [...window.__terminalTest.controllers.values()][0].terminal.selectAll());
  await page.keyboard.press('Control+Shift+C');
  await expect
    .poll(() => bridge(() => window.__terminalTest.invoke('plugin:clipboard-manager|read_text')))
    .toContain('KEY_복사붙여넣기');
  pass('Ctrl+Shift+C/V preserve Unicode through real clipboard');

  await send(0, "Write-Output ('IME_' + '");
  await page.locator('.terminal-pane').first().locator('textarea').focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', {
    text: '한글조합',
    selectionStart: 4,
    selectionEnd: 4,
  });
  await cdp.send('Input.insertText', { text: '한글조합' });
  await delay(100);
  await send(0, "')");
  await page.keyboard.press('Enter');
  await expect.poll(() => buffer(0), { timeout: 15000 }).toMatch(/^IME_한글조합$/m);
  const koreanCellWidth = await bridge(() => {
    const buffer = [...window.__terminalTest.controllers.values()][0].terminal.buffer.active;
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line?.translateToString(true) === 'IME_한글조합') return line.getCell(4)?.getWidth();
    }
  });
  assert.equal(koreanCellWidth, 2, 'Hangul must occupy two terminal columns');
  pass('WebView2 IME composition commits Korean without duplication');

  const idsBefore = await pids();
  const metricsBefore = await bridge(() =>
    [...window.__terminalTest.controllers.values()].map((ctrl) => ({
      cols: ctrl.terminal.cols,
      rows: ctrl.terminal.rows,
    })),
  );
  await page.getByRole('button', { name: '화면 설정', exact: true }).click();
  await page.getByLabel('터미널 글꼴', { exact: false }).fill('Consolas');
  await page.getByLabel('글자 크기', { exact: true }).fill('19');
  await page.getByLabel('줄 간격', { exact: true }).selectOption('1.4');
  await page.getByRole('button', { name: '완료', exact: true }).click();
  await expect
    .poll(() =>
      bridge(() =>
        [...window.__terminalTest.controllers.values()].every(
          (ctrl) =>
            ctrl.terminal.options.fontSize === 19 &&
            ctrl.terminal.options.fontFamily.includes('Consolas'),
        ),
      ),
    )
    .toBe(true);
  const metricsAfter = await bridge(() =>
    [...window.__terminalTest.controllers.values()].map((ctrl) => ({
      cols: ctrl.terminal.cols,
      rows: ctrl.terminal.rows,
    })),
  );
  assert(metricsAfter[0].cols < metricsBefore[0].cols);
  assert.deepEqual(await pids(), idsBefore, 'appearance must not restart shell processes');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('multi-terminal.settings.v1')).fontSize),
    )
    .toBe(19);
  pass('font, size and line height apply to all panes without restarting shells and persist');

  await page.getByRole('separator', { name: '좌우 패널 크기' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('separator', { name: '좌우 패널 크기' })).toHaveAttribute(
    'aria-valuenow',
    '48',
  );
  // Resizing deliberately debounces native calls by 60ms; wait for the layout
  // frame and its serialized resize IPC before querying the shell geometry.
  await delay(200);
  await bridge(() =>
    Promise.all([...window.__terminalTest.controllers.values()].map((ctrl) => ctrl.resizeQueue)),
  );
  await command(
    0,
    "Write-Output ('GEOMETRY_' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight)",
  );
  await expect.poll(() => buffer(0)).toMatch(/GEOMETRY_\d+x\d+/);
  const currentGeometry = await bridge(() => {
    const term = [...window.__terminalTest.controllers.values()][0].terminal;
    return `${term.cols}x${term.rows}`;
  });
  assert((await buffer(0)).includes(`GEOMETRY_${currentGeometry}`));
  pass('panel resizing reaches real ConPTY rows and columns');

  await command(1, "1..12000 | ForEach-Object { 'FLOW_' + $_ }; Write-Output ('FLOW_' + 'DONE')");
  await expect.poll(() => buffer(1), { timeout: 45000 }).toContain('FLOW_DONE');
  pass('large output crosses the bounded output window without stalling');

  await command(2, 'Start-Sleep -Seconds 60');
  await delay(150);
  await page.keyboard.press('Control+c');
  await expect
    .poll(async () => (await buffer(2)).split('Start-Sleep -Seconds 60').at(-1), { timeout: 10000 })
    .toMatch(/PS C:.*>/);
  await command(2, "Write-Output ('SIGNAL_' + 'OK')");
  await expect.poll(() => buffer(2), { timeout: 15000 }).toContain('SIGNAL_OK');
  pass('plain Ctrl+C still interrupts shell commands');

  await page.screenshot({ path: path.join(root, 'test-results', 'four-terminals.png') });
  await command(
    3,
    "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru; Write-Output ('CHILD_' + $child.Id)",
  );
  await expect.poll(() => buffer(3)).toMatch(/CHILD_\d+/);
  const descendantPid = Number((await buffer(3)).match(/CHILD_(\d+)/)?.[1]);
  assert(descendantPid && processExists(descendantPid));
  const closedPid = (await pids())[3];
  await page.getByRole('button', { name: '터미널 4 닫기', exact: true }).click();
  await expect(page.locator('.terminal-pane')).toHaveCount(3);
  await expect.poll(() => processExists(closedPid)).toBe(false);
  await expect.poll(() => processExists(descendantPid)).toBe(false);
  await page.getByRole('button', { name: '터미널 추가', exact: true }).click();
  await expect(page.locator('.pane-status', { hasText: '실행 중' })).toHaveCount(4);
  pass('closing kills the owned shell and releases a slot for replacement');

  await command(3, 'exit 7');
  await expect(page.locator('.terminal-pane').nth(3).locator('.pane-status')).toHaveText('종료됨');
  await expect.poll(() => buffer(3)).toContain('코드 7');
  await page.getByRole('button', { name: '터미널 5 다시 시작', exact: true }).click();
  await expect(page.locator('.pane-status', { hasText: '실행 중' })).toHaveCount(4);
  pass('natural exit preserves status code and supports restart');

  const beforeReload = await pids();
  await page.reload();
  await page.waitForFunction(() => window.__terminalTest?.controllers.size === 1);
  await expect(page.locator('.pane-status')).toHaveText('실행 중');
  for (const pid of beforeReload)
    await expect.poll(() => processExists(pid), { timeout: 15000 }).toBe(false);
  await expect
    .poll(() =>
      bridge(() => [...window.__terminalTest.controllers.values()][0].terminal.options.fontSize),
    )
    .toBe(19);
  pass('document reload restores settings and cleans the previous PTY sessions');

  // Restore appearance and clipboard, then close the native window gracefully.
  await bridge(
    (text) => window.__terminalTest.invoke('plugin:clipboard-manager|write_text', { text }),
    previousClipboard ?? '',
  );
  previousClipboard = undefined;
  await page.evaluate((saved) => {
    if (saved === null) localStorage.removeItem('multi-terminal.settings.v1');
    else localStorage.setItem('multi-terminal.settings.v1', saved);
  }, previousSettings);
  previousSettings = undefined;
  const remainingPids = await pids();
  assert.deepEqual(errors, [], 'No uncaught frontend errors');
  await bridge(() => {
    void window.__terminalTest.invoke('plugin:window|close', { label: 'main' });
  });
  for (const pid of remainingPids)
    await expect.poll(() => processExists(pid), { timeout: 15000 }).toBe(false);
  pass('native window close cleans all remaining shell processes');
  console.log(`\n${checks.length} desktop integration checks passed.`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(root, 'test-results', 'failure.png') }).catch(() => {});
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  if (page && !page.isClosed()) {
    if (previousClipboard !== undefined)
      await bridge(
        (text) => window.__terminalTest.invoke('plugin:clipboard-manager|write_text', { text }),
        previousClipboard ?? '',
      ).catch(() => {});
    if (previousSettings !== undefined)
      await page
        .evaluate((saved) => {
          if (saved === null) localStorage.removeItem('multi-terminal.settings.v1');
          else localStorage.setItem('multi-terminal.settings.v1', saved);
        }, previousSettings)
        .catch(() => {});
    await bridge(() => {
      void window.__terminalTest.invoke('plugin:window|close', { label: 'main' });
    }).catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    await delay(1000);
    if (child.exitCode === null) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    }
  }
}
