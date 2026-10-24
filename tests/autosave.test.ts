/**
 * Autosave: every scheduling rule as a pure function, then one round trip
 * through IndexedDB on a database of its own, so the real store is never
 * touched and nothing is left behind.
 */
import {
  autosaveAvailable, clearAllAutosaves, DEBOUNCE_MS, deleteAutosave, deleteAutosaveIfUnchanged,
  freshTiming, isSlow, listAutosaves, markChanged, markClean, markFailed, markWritten, MAX_WAIT_MS,
  planAutosave, recoveredName, SLOW_SERIALIZE_MS, slowNoticeDue, writeAutosave, type AutosaveEntry,
} from '../src/core/autosave';
import { assert, group, test } from './harness';

const TEST_DB = 'photograp-test';
const T0 = 1_000_000;

const entry = (id: string, savedAt: string): AutosaveEntry => ({
  id, name: `文件 ${id}`, savedAt, revision: 3, width: 64, height: 48, layers: 2, bytes: 13,
  json: '{"magic":"x"}',
});

export async function autosaveTests(): Promise<void> {
  group('自動儲存');
  await test('文件不是 dirty 就不存', () => {
    const t = markChanged(freshTiming(0), 1, T0);
    assert(planAutosave(t, false, T0 + MAX_WAIT_MS * 2).action === 'idle', '乾淨的文件不該排程');
    assert(planAutosave(freshTiming(0), true, T0).action === 'idle', '沒看到任何變更就不排程');
    const clean = markClean({ ...t, lastDurationMs: 42 }, 1);
    assert(clean.firstChangeAt === null && clean.lastChangeAt === null, '存檔後要清掉待存的時間');
    assert(clean.lastDurationMs === 42, '存檔不會忘記上次序列化花了多久');
  });
  await test('最後一次變更後 30 秒沒再變更才存', () => {
    let t = markChanged(freshTiming(0), 1, T0);
    const early = planAutosave(t, true, T0 + DEBOUNCE_MS - 1);
    assert(early.action === 'wait' && early.until === T0 + DEBOUNCE_MS, '30 秒內要等');
    t = markChanged(t, 2, T0 + 20_000);
    const pushed = planAutosave(t, true, T0 + DEBOUNCE_MS);
    assert(pushed.action === 'wait' && pushed.until === T0 + 20_000 + DEBOUNCE_MS, '再變更會把時間往後推');
    assert(planAutosave(t, true, T0 + 20_000 + DEBOUNCE_MS).action === 'save', '安靜 30 秒後要存');
  });
  await test('持續變更時從第一次變更起最多等 120 秒', () => {
    let t = freshTiming(0);
    for (let i = 1; i * 10_000 <= MAX_WAIT_MS; i++) t = markChanged(t, i, T0 + i * 10_000);
    assert(t.firstChangeAt === T0 + 10_000 && t.lastChangeAt === T0 + MAX_WAIT_MS, '首尾時間要正確');
    const before = planAutosave(t, true, T0 + 10_000 + MAX_WAIT_MS - 1);
    assert(before.action === 'wait' && before.until === T0 + 10_000 + MAX_WAIT_MS, '上限前等到上限');
    assert(planAutosave(t, true, T0 + 10_000 + MAX_WAIT_MS).action === 'save', '到 120 秒就算剛變更過也要存');
  });
  await test('序列化超過 1.5 秒就把等待加倍，提醒只有一次', () => {
    assert(!isSlow(SLOW_SERIALIZE_MS) && isSlow(SLOW_SERIALIZE_MS + 1), '門檻是嚴格大於 1500 ms');
    const slow = markWritten(markChanged(freshTiming(0), 1, T0), 1, 1600, T0 + 5);
    assert(slow.firstChangeAt === null && slow.lastDurationMs === 1600, '寫完且沒有新變更就沒有待存');
    const t = markChanged(slow, 2, T0 + 10_000);
    const wait = planAutosave(t, true, T0 + 10_000 + DEBOUNCE_MS);
    assert(wait.action === 'wait' && wait.until === T0 + 10_000 + DEBOUNCE_MS * 2, '慢文件的去抖要加倍');
    const busy = markChanged(t, 3, T0 + 10_000 + MAX_WAIT_MS * 2 - 1);
    const cap = planAutosave(busy, true, T0 + 10_000 + MAX_WAIT_MS * 2 - 1);
    assert(cap.action === 'wait' && cap.until === T0 + 10_000 + MAX_WAIT_MS * 2, '慢文件的上限也加倍');
    assert(planAutosave(busy, true, T0 + 10_000 + MAX_WAIT_MS * 2).action === 'save', '到了加倍後的上限要存');
    const fast = markWritten(busy, 3, 200, T0 + 300_000);
    assert(planAutosave(markChanged(fast, 4, T0 + 300_000), true, T0 + 300_000 + DEBOUNCE_MS).action === 'save',
      '變快之後等待回到 30 秒');
    assert(slowNoticeDue(1600, false), '第一次變慢要提醒');
    assert(!slowNoticeDue(1600, true) && !slowNoticeDue(100, false), '提醒過就不再提醒，不慢也不提醒');
  });
  await test('寫入期間的變更會重新計時', () => {
    // Revision 2 arrived while revision 1 was being written.
    const t = markChanged(markChanged(freshTiming(0), 1, T0), 2, T0 + 500);
    const w = markWritten(t, 1, 100, T0 + 900);
    assert(w.revision === 2 && w.firstChangeAt === T0 + 900 && w.lastChangeAt === T0 + 900,
      '寫入中漏掉的變更要從寫完開始算');
    assert(planAutosave(w, true, T0 + 900 + DEBOUNCE_MS - 1).action === 'wait', '新的一輪照樣先等');
    assert(planAutosave(w, true, T0 + 900 + DEBOUNCE_MS).action === 'save', '之後照一般規則存');
  });
  await test('寫入失敗後安靜 30 秒再試', () => {
    const t = markChanged(freshTiming(0), 1, T0);
    const f = markFailed({ ...t, lastDurationMs: 7 }, T0 + 200_000);
    assert(f.revision === 1 && f.firstChangeAt === T0 + 200_000 && f.lastChangeAt === T0 + 200_000,
      '重試的時間窗從失敗那一刻起算');
    assert(f.lastDurationMs === 7, '失敗不會忘記上次序列化花了多久');
    assert(planAutosave(f, true, T0 + 200_000 + DEBOUNCE_MS - 1).action === 'wait', '不會立刻重試');
    assert(planAutosave(f, true, T0 + 200_000 + DEBOUNCE_MS).action === 'save', '安靜 30 秒後重試');
  });
  await test('復原的文件名稱加上（已復原）', () => {
    assert(recoveredName('未命名-1') === '未命名-1（已復原）', '沒有副檔名就直接加在後面');
    assert(recoveredName('貓.pgraph') === '貓（已復原）.pgraph', '有 .pgraph 時插在副檔名前');
    assert(recoveredName('貓（已復原）.pgraph') === '貓（已復原）.pgraph', '復原兩次不重複加');
    assert(recoveredName('  ') === '未命名（已復原）', '空名稱要有預設');
  });
  await test('IndexedDB 寫入、列出、刪除、清空', async () => {
    assert(await clearAllAutosaves(TEST_DB), '測試開始前要能清空');
    assert(await writeAutosave(entry('a', '2026-10-24T01:00:00.000Z'), TEST_DB), '寫入 a');
    assert(await writeAutosave(entry('b', '2026-10-24T02:00:00.000Z'), TEST_DB), '寫入 b');
    let list = await listAutosaves(TEST_DB);
    assert(list.length === 2 && list[0].id === 'b' && list[1].id === 'a', '列出兩筆且最新的在前');
    assert(list[0].json === '{"magic":"x"}' && list[0].layers === 2 && list[0].name === '文件 b', '欄位要原樣回來');
    assert(await writeAutosave({ ...entry('a', '2026-10-24T03:00:00.000Z'), revision: 4 }, TEST_DB), '覆寫 a');
    list = await listAutosaves(TEST_DB);
    assert(list.length === 2 && list[0].id === 'a' && list[0].revision === 4, '同一個 id 是覆寫不是新增');
    assert(await deleteAutosaveIfUnchanged('a', '2026-10-24T01:00:00.000Z', TEST_DB), '條件刪除要能執行');
    assert((await listAutosaves(TEST_DB)).length === 2, '紀錄已被更新過（savedAt 不同）就不刪');
    assert(await deleteAutosaveIfUnchanged('a', '2026-10-24T03:00:00.000Z', TEST_DB), '條件刪除符合時執行');
    list = await listAutosaves(TEST_DB);
    assert(list.length === 1 && list[0].id === 'b', 'savedAt 相同才真的刪掉，剩 b');
    assert(await writeAutosave(entry('c', '2026-10-24T04:00:00.000Z'), TEST_DB) && await deleteAutosave('c', TEST_DB),
      '無條件刪除');
    assert((await listAutosaves(TEST_DB)).length === 1, '無條件刪除後仍只剩 b');
    assert(await clearAllAutosaves(TEST_DB), '清空');
    assert((await listAutosaves(TEST_DB)).length === 0, '清空後是空的');
    assert(autosaveAvailable(), '瀏覽器裡 IndexedDB 應該可用');
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(TEST_DB);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
}
