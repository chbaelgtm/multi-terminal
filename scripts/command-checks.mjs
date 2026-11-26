import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkCommandReference({ page, root, buffer, pids, pass }) {
  await expect.poll(() => buffer(0)).toContain('PS ');
  const beforePids = await pids();
  const beforeOutput = await buffer(0);
  const trigger = page.getByRole('button', { name: '명령어 모음', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '명령어 모음', exact: true });
  await expect(dialog).toBeVisible();
  const search = page.getByRole('textbox', { name: '명령어 검색', exact: true });
  await expect(search).toBeFocused();
  await expect(page.getByRole('tab', { name: /PowerShell/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.locator('.command-card')).toHaveCount(21);
  await page.getByRole('button', { name: '현재 위치 확인 명령어 복사', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__terminalTest.invoke('plugin:clipboard-manager|read_text')),
    )
    .toBe('Get-Location');
  await expect(dialog.getByRole('status')).toContainText('명령어를 복사했습니다');
  assert.equal(
    await buffer(0),
    beforeOutput,
    'copying a reference must never write or execute in a terminal',
  );
  pass(
    'command reference opens beside settings, focuses search, and copies PowerShell without execution',
  );

  await search.fill('로그');
  await expect(dialog.locator('.command-card')).toHaveCount(3);
  await expect(dialog).toContainText('로그 실시간 보기');
  await page.getByRole('button', { name: '명령어 검색 지우기', exact: true }).click();
  await page.getByRole('button', { name: '네트워크', exact: true }).click();
  await expect(dialog.locator('.command-card')).toHaveCount(3);
  await search.fill('3000');
  await expect(dialog.locator('.command-card')).toHaveCount(2);
  await search.fill('no-such-command-123456');
  await expect(dialog.getByRole('heading', { name: '일치하는 명령어가 없습니다.' })).toBeVisible();
  await page.getByRole('button', { name: '전체 명령어 보기', exact: true }).click();
  await expect(dialog.locator('.command-card')).toHaveCount(21);
  pass('command search combines Korean text with categories and recovers from empty results');

  await page.getByRole('tab', { name: /^CMD/ }).click();
  await expect(dialog.locator('.command-card')).toHaveCount(22);
  await page.getByRole('button', { name: '이동·탐색', exact: true }).click();
  await page.getByRole('button', { name: '파일과 폴더 목록 명령어 복사', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__terminalTest.invoke('plugin:clipboard-manager|read_text')),
    )
    .toBe('dir /a');
  await search.focus();
  await page.keyboard.press('Control+Shift+t');
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await search.fill('IPCONFIG');
  await expect(dialog.locator('.command-card')).toHaveCount(1);
  await expect(dialog.locator('code')).toHaveText('ipconfig /all');
  await page.getByRole('button', { name: '명령어 검색 지우기', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'test-results', 'command-reference.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  assert.deepEqual(
    await pids(),
    beforePids,
    'reference browsing must not restart terminal sessions',
  );
  assert.equal(await buffer(0), beforeOutput);
  pass('CMD examples copy correctly; modal blocks terminal shortcuts and restores keyboard focus');
}
