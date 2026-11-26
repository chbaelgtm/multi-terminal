import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export async function checkVim({ page, root, buffer, command, pids, pass }) {
  const executable = process.env.TERMINAL_VIM_EXE || 'C:\\Program Files\\Git\\usr\\bin\\vim.exe';
  await access(executable);
  const directory = path.join(root, 'test-results', `vim-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const files = Array.from({ length: 4 }, (_, index) =>
    path.join(directory, `vim-pane-${index + 1}.txt`),
  );
  await Promise.all(files.map((file, i) => writeFile(file, `seed_${i + 1}\n`, 'utf8')));
  const initialPids = await pids();
  const bridge = (fn, arg) => page.evaluate(fn, arg);
  const snapshot = (index) =>
    bridge((index) => {
      const terminal = [...window.__terminalTest.controllers.values()][index].terminal;
      return {
        type: terminal.buffer.active.type,
        x: terminal.buffer.active.cursorX,
        y: terminal.buffer.active.cursorY,
        cols: terminal.cols,
        rows: terminal.rows,
      };
    }, index);
  const focus = (index) => page.locator('.terminal-pane').nth(index).locator('textarea').focus();
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const cdp = await page.context().newCDPSession(page);
  const colon = async (index, text) => {
    await focus(index);
    await page.keyboard.type(`:${text}`);
    await page.keyboard.press('Enter');
  };
  for (let i = 0; i < 4; i++) {
    await command(
      i,
      `& ${quote(executable)} -Nu NONE -n -i NONE -N -c ${quote('set encoding=utf-8 fileencoding=utf-8 showmode noruler noshowcmd nowrap')} ${quote(files[i])}`,
    );
    await expect.poll(async () => (await snapshot(i)).type, { timeout: 15000 }).toBe('alternate');
    await expect.poll(() => buffer(i)).toContain(`seed_${i + 1}`);
    await focus(i);
    await page.keyboard.type('gg0i');
    await page.keyboard.type(`PANE_${i + 1} `);
    await cdp.send('Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.imeSetComposition', {
      text: '한글입력',
      selectionStart: 4,
      selectionEnd: 4,
    });
    await cdp.send('Input.insertText', { text: '한글입력' });
    await expect.poll(() => buffer(i)).toContain(`PANE_${i + 1} 한글입력`);
    await bridge(
      (text) => window.__terminalTest.invoke('plugin:clipboard-manager|write_text', { text }),
      ` 클립보드_${i + 1}`,
    );
    await page.keyboard.press('Control+Shift+V');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.type('gg0');
    await expect.poll(async () => (await snapshot(i)).x).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await snapshot(i)).x).toBe(1);
    await page.keyboard.type('j');
    await expect.poll(async () => (await snapshot(i)).y).toBe(1);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await snapshot(i)).y).toBe(0);
    await page.keyboard.type('lh');
    await expect.poll(async () => (await snapshot(i)).x).toBe(1);
  }
  assert.deepEqual(await pids(), initialPids);
  pass(
    'four simultaneous Vim editors use separate alternate screens; Korean IME, Escape and navigation work',
  );

  await bridge(() =>
    window.__terminalTest.invoke('plugin:clipboard-manager|write_text', { text: '' }),
  );
  for (let i = 0; i < 4; i++) {
    await focus(i);
    await page.keyboard.press('Control+v');
    await expect.poll(() => buffer(i)).toContain('-- VISUAL BLOCK --');
    await page.keyboard.press('Escape');
    await expect.poll(() => buffer(i)).not.toContain('-- VISUAL BLOCK --');
  }
  pass('Vim Ctrl+V block selection reaches all four editors without clipboard interception');

  await page.getByRole('button', { name: '화면 설정', exact: true }).click();
  await page.getByLabel('창 크기', { exact: true }).selectOption('1280x720');
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
  await page.getByRole('button', { name: '완료', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  for (let i = 0; i < 4; i++) {
    await colon(i, "echo 'VIM_SIZE_' . &columns . 'x' . &lines");
    await expect
      .poll(async () => {
        const size = await snapshot(i);
        return (await buffer(i)).includes(`VIM_SIZE_${size.cols}x${size.rows}`);
      })
      .toBe(true);
    await expect.poll(() => buffer(i)).toContain(`PANE_${i + 1} 한글입력`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+l');
    await expect.poll(() => buffer(i)).toContain(`PANE_${i + 1} 한글입력 클립보드_${i + 1}`);
  }
  await page.screenshot({ path: path.join(root, 'test-results', 'vim-four-terminals.png') });
  pass('all four Vim screens redraw after window resize and report matching PTY dimensions');

  for (let i = 0; i < 4; i++) {
    await colon(i, 'wq');
    await expect.poll(async () => (await snapshot(i)).type).toBe('normal');
    const content = (await readFile(files[i], 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(content, `PANE_${i + 1} 한글입력 클립보드_${i + 1}\nseed_${i + 1}\n`);
    await command(i, `Write-Output ('VIM_RETURN_' + '${i + 1}')`);
    await expect.poll(() => buffer(i)).toContain(`VIM_RETURN_${i + 1}`);
    for (let other = 0; other < 4; other++) {
      if (other !== i) assert(!(await buffer(i)).includes(`VIM_RETURN_${other + 1}`));
    }
  }
  pass(
    'each Vim saves exact UTF-8 contents, exits with :wq, and restores its independent shell screen',
  );
}
