import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'src-tauri/target/release/multi-terminal.exe');
const app = spawn(executable, [], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9224',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'test-results', 'release-webview'),
  },
});
let browser, page;
try {
  for (let i = 0; i < 60; i++) {
    if (app.exitCode !== null) throw new Error(`Release app exited with ${app.exitCode}`);
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
      break;
    } catch {
      await delay(500);
    }
  }
  assert(browser, 'release WebView2 did not start');
  await expect
    .poll(() => browser.contexts().flatMap((context) => context.pages()).length)
    .toBeGreaterThan(0);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  await expect(page).toHaveTitle('Multi Terminal');
  assert(page.url().includes('tauri.localhost'), 'release must use bundled assets');
  assert.equal(await page.evaluate(() => typeof window.__terminalTest), 'undefined');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('.pane-status')).toHaveText('실행 중');
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: '터미널 추가', exact: true }).click();
  await expect(page.locator('.pane-status', { hasText: '실행 중' })).toHaveCount(4);
  await expect(page.getByRole('button', { name: '터미널 추가', exact: true })).toBeDisabled();
  for (let i = 0; i < 4; i++) {
    await page.locator('.terminal-pane').nth(i).locator('textarea').focus();
    await page.keyboard.type(`Write-Output ('RELEASE_' + 'PANE_${i + 1}')`);
    await page.keyboard.press('Enter');
    await expect(page.locator('.terminal-pane').nth(i)).toContainText(`RELEASE_PANE_${i + 1}`);
  }
  await delay(500);
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results', 'release-four-terminals.png') });
  assert.deepEqual(errors, []);
  console.log(
    'PASS release executable starts four real PTYs from bundled assets without the dev test bridge',
  );
} finally {
  if (page && !page.isClosed()) {
    await page
      .evaluate(() => {
        void window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' });
      })
      .catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (app.exitCode === null) {
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), delay(10000)]);
    if (app.exitCode === null) app.kill();
  }
}
