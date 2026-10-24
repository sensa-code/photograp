/**
 * Shared helpers for the browser test suite. suite.ts and the other test files
 * register their cases here; render() writes the results into the page.
 */
import { createSurface } from '../src/core/surface';

interface Case { name: string; error?: string }
const groups: { name: string; cases: Case[] }[] = [];
let current: { name: string; cases: Case[] } | null = null;

export function group(name: string): void {
  current = { name, cases: [] };
  groups.push(current);
}

export async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    current!.cases.push({ name });
  } catch (err) {
    current!.cases.push({ name, error: err instanceof Error ? err.message : String(err) });
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function near(a: number, b: number, tol: number, message: string): void {
  if (Math.abs(a - b) > tol) throw new Error(`${message}（${a} ≉ ${b}，容許 ${tol}）`);
}

export const pixel = (s: { ctx: CanvasRenderingContext2D }, x: number, y: number): number[] =>
  [...s.ctx.getImageData(x, y, 1, 1).data];

export function filled(w: number, h: number, css: string): ReturnType<typeof createSurface> {
  const s = createSurface(w, h);
  s.ctx.fillStyle = css;
  s.ctx.fillRect(0, 0, w, h);
  return s;
}

export function render(): void {
  const out = document.getElementById('out')!;
  let pass = 0, fail = 0;
  out.innerHTML = '';
  for (const g of groups) {
    const head = document.createElement('div');
    head.className = 'group';
    head.textContent = g.name;
    out.append(head);
    for (const c of g.cases) {
      const row = document.createElement('div');
      row.className = 'case';
      if (c.error) {
        fail++;
        row.innerHTML = `<span class="fail">✕ ${c.name}</span><span class="why">${c.error}</span>`;
      } else {
        pass++;
        row.innerHTML = `<span class="ok">✓</span> ${c.name}`;
      }
      out.append(row);
    }
  }
  const summary = document.getElementById('summary')!;
  summary.className = fail === 0 ? 'ok' : 'fail';
  summary.textContent = fail === 0
    ? `全部通過：${pass} 項測試`
    : `${pass} 項通過，${fail} 項失敗`;
  (window as unknown as { __testResult: unknown }).__testResult = { pass, fail };
}
