/**
 * Launch-readiness checks: the error guard's debounce and the document size
 * limits. A file of its own so suite.ts stops growing.
 */
import { checkDocumentSize, fitWithinLimit, MAX_PIXELS, MAX_SIDE } from '../src/core/limits';
import { REPORT_GAP_MS, shouldReport } from '../src/ui/error-guard';
import { assert, group, near, test } from './harness';

export async function launchTests(): Promise<void> {
  group('上線保障');
  await test('同一則錯誤 2 秒內只回報一次', () => {
    const log = new Map<string, number>();
    assert(shouldReport('爆了', 1000, log), '第一次應該回報');
    assert(!shouldReport('爆了', 1000 + REPORT_GAP_MS - 1, log), '2 秒內的重複不該回報');
    assert(shouldReport('另一個錯誤', 1500, log), '不同訊息應該立刻回報');
    assert(shouldReport('爆了', 1000 + REPORT_GAP_MS, log), '2 秒後應該再回報');
    assert(!shouldReport('爆了', 1000 + REPORT_GAP_MS + 500, log), '再回報後計時要重來');
  });
  await test('checkDocumentSize 擋下超限尺寸', () => {
    assert(checkDocumentSize(8000, 5000).ok, '剛好 4,000 萬像素應該可以');
    assert(checkDocumentSize(1, 1).ok, '1 × 1 應該可以');
    const pixels = checkDocumentSize(8001, 5000);
    assert(!pixels.ok && /[一-鿿]/.test(pixels.reason), '超過像素數要擋下並給中文理由');
    const side = checkDocumentSize(MAX_SIDE + 1, 10);
    assert(!side.ok && /[一-鿿]/.test(side.reason), '超過單邊要擋下並給中文理由');
    assert(!checkDocumentSize(0, 100).ok, '0 px 寬要擋下');
  });
  await test('fitWithinLimit 等比縮到上限內', () => {
    const big = fitWithinLimit(16000, 10000);
    assert(big.scaled, '超限的尺寸應該標記已縮放');
    near(big.w / big.h, 1.6, 0.001, '要保持長寬比');
    assert(big.w * big.h <= MAX_PIXELS, '縮放後要在像素上限內');
    assert(checkDocumentSize(big.w, big.h).ok, '縮放後要通過尺寸檢查');
    const wide = fitWithinLimit(40000, 100);
    assert(wide.scaled && wide.w <= MAX_SIDE, '超過單邊也要縮到上限內');
    assert(checkDocumentSize(wide.w, wide.h).ok, '縮過單邊後要通過尺寸檢查');
    const small = fitWithinLimit(100, 50);
    assert(!small.scaled && small.w === 100 && small.h === 50, '上限內的尺寸不該放大也不該改動');
    const exact = fitWithinLimit(8000, 5000);
    assert(!exact.scaled && exact.w === 8000 && exact.h === 5000, '剛好在上限內要原樣回傳');
  });
}
