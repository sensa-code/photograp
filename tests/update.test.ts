/**
 * Auto-update surface as the browser sees it: no bridge, so the check reports
 * "not the desktop build" instead of failing, and the version shown in the
 * About dialog is the one in package.json.
 */
import pkg from '../package.json';
import { app } from '../src/core/app';
import { desktopCheckForUpdates, isDesktop } from '../src/io/desktop';
import { commandEnabled, getCommand } from '../src/ui/commands';
import { assert, group, test } from './harness';

export async function updateTests(): Promise<void> {
  group('自動更新');
  await test('瀏覽器裡 desktopCheckForUpdates 回 null 而不是丟錯', async () => {
    assert(!isDesktop(), '測試頁不該有桌面橋接');
    const result = await desktopCheckForUpdates();
    assert(result === null, `瀏覽器應該回 null，實際是 ${JSON.stringify(result)}`);
  });
  await test('「檢查更新…」指令存在，但只在桌面版可用', () => {
    const command = getCommand('help.checkUpdates');
    assert(command, '應該有 help.checkUpdates 指令');
    assert(command.label === '檢查更新…', `標籤不對：${command.label}`);
    assert(!commandEnabled(app, 'help.checkUpdates'), '瀏覽器裡應該是停用的');
  });
  await test('__APP_VERSION__ 等於 package.json 的版本', () => {
    assert(__APP_VERSION__ === pkg.version, `${__APP_VERSION__} ≠ ${pkg.version}`);
    assert(/^\d+\.\d+\.\d+/.test(__APP_VERSION__), '版本號應該是 X.Y.Z');
  });
}
