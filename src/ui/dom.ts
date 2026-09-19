export type Attrs = Record<string, string | number | boolean | undefined | null>;

/** Terse element builder used across the UI layer. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs?: Attrs, ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'style') node.setAttribute('style', String(v));
      else if (k.startsWith('data') || k.startsWith('aria')) node.setAttribute(k, String(v));
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget, type: K | string,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Collapse rapid calls into one animation frame. */
export function raf(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}

export const fmt = (n: number, digits = 0): string =>
  n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Drag a number by dragging a label horizontally, like Photoshop scrubbers. */
export function scrubbable(
  label: HTMLElement, get: () => number, set: (v: number) => void,
  step = 1, min = -Infinity, max = Infinity,
): void {
  label.classList.add('scrubbable');
  label.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startV = get();
    label.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent): void => {
      const delta = (e.clientX - startX) * step * (e.shiftKey ? 5 : 1);
      set(Math.min(max, Math.max(min, startV + delta)));
    };
    const up = (): void => {
      label.removeEventListener('pointermove', move);
      label.removeEventListener('pointerup', up);
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
  });
}
