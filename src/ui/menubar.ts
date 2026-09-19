import type { App } from '../core/app';
import { clear, el, on } from './dom';
import { icon } from './icons';
import { getCommand, runCommand } from './commands';
import { MENUS, type MenuEntry } from './menus';

export class MenuBar {
  readonly root: HTMLElement;
  private openPopups: HTMLElement[] = [];
  private openIndex = -1;
  private titles: HTMLElement[] = [];

  constructor(private app: App) {
    this.root = el('div', { class: 'menubar' },
      el('div', { class: 'brand' },
        el('span', { html: icon('shape', 16) }),
        el('span', { text: 'Photograp' }),
        el('small', { text: '開源影像編輯器' })));

    MENUS.forEach((menu, i) => {
      const item = el('div', { class: 'menu-item', text: menu.label });
      on(item, 'pointerdown', (ev) => {
        ev.preventDefault();
        if (this.openIndex === i) this.closeAll();
        else this.openMenu(i);
      });
      on(item, 'pointerenter', () => { if (this.openIndex >= 0 && this.openIndex !== i) this.openMenu(i); });
      this.titles.push(item);
      this.root.append(item);
    });

    on(document, 'pointerdown', (ev) => {
      const target = ev.target as Node;
      if (this.root.contains(target)) return;
      if (this.openPopups.some((p) => p.contains(target))) return;
      this.closeAll();
    }, { capture: true });

    on(document, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') this.closeAll();
    });
  }

  closeAll(): void {
    for (const p of this.openPopups) p.remove();
    this.openPopups = [];
    this.titles.forEach((t) => t.classList.remove('open'));
    this.openIndex = -1;
  }

  private openMenu(index: number): void {
    this.closeAll();
    this.openIndex = index;
    this.titles[index].classList.add('open');
    const rect = this.titles[index].getBoundingClientRect();
    const pop = this.buildPopup(MENUS[index].items);
    pop.style.left = `${rect.left}px`;
    pop.style.top = `${rect.bottom + 2}px`;
    document.body.append(pop);
    this.openPopups.push(pop);
    this.clampToViewport(pop);
  }

  private clampToViewport(pop: HTMLElement): void {
    const r = pop.getBoundingClientRect();
    if (r.right > window.innerWidth - 6) {
      pop.style.left = `${Math.max(6, window.innerWidth - r.width - 6)}px`;
    }
    if (r.bottom > window.innerHeight - 6) {
      pop.style.top = `${Math.max(6, window.innerHeight - r.height - 6)}px`;
    }
  }

  private buildPopup(items: MenuEntry[]): HTMLElement {
    const pop = el('div', { class: 'menu-pop' });
    let submenu: HTMLElement | null = null;

    const closeSubmenu = (): void => {
      if (submenu) {
        submenu.remove();
        this.openPopups = this.openPopups.filter((p) => p !== submenu);
        submenu = null;
      }
    };

    for (const entry of items) {
      if (entry.kind === 'sep') {
        pop.append(el('div', { class: 'menu-sep' }));
        continue;
      }
      if (entry.kind === 'sub') {
        const row = el('div', { class: 'menu-row' },
          el('span', { text: entry.label }),
          el('span', { class: 'submenu-arrow', html: icon('chevron', 13) }));
        on(row, 'pointerenter', () => {
          closeSubmenu();
          const r = row.getBoundingClientRect();
          const child = this.buildPopup(entry.items);
          child.style.left = `${r.right - 3}px`;
          child.style.top = `${r.top - 4}px`;
          document.body.append(child);
          this.openPopups.push(child);
          submenu = child;
          this.clampToViewport(child);
        });
        pop.append(row);
        continue;
      }

      const command = getCommand(entry.id);
      if (!command) continue;
      const enabled = command.enabled ? command.enabled(this.app) : true;
      const checked = command.checked?.(this.app) ?? false;
      const row = el('div', { class: `menu-row${enabled ? '' : ' disabled'}` },
        el('span', { text: `${checked ? '✓ ' : ''}${command.label}` }),
        command.shortcut ? el('kbd', { text: command.shortcut }) : null);
      on(row, 'pointerenter', closeSubmenu);
      on(row, 'click', () => {
        if (!enabled) return;
        this.closeAll();
        runCommand(this.app, entry.id);
      });
      pop.append(row);
    }
    return pop;
  }

  refresh(): void {
    if (this.openIndex >= 0) {
      const i = this.openIndex;
      this.openMenu(i);
    }
  }
}

/** A standalone dropdown used by panel buttons. */
export function popupMenu(
  anchor: HTMLElement, items: MenuEntry[], app: App, extra?: { label: string; run: () => void }[],
): void {
  const pop = el('div', { class: 'menu-pop' });
  const close = (): void => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (ev: Event): void => {
    if (!pop.contains(ev.target as Node)) close();
  };

  for (const entry of items) {
    if (entry.kind === 'sep') { pop.append(el('div', { class: 'menu-sep' })); continue; }
    if (entry.kind === 'sub') continue;
    const command = getCommand(entry.id);
    if (!command) continue;
    const enabled = command.enabled ? command.enabled(app) : true;
    const row = el('div', { class: `menu-row${enabled ? '' : ' disabled'}` },
      el('span', { text: command.label }),
      command.shortcut ? el('kbd', { text: command.shortcut }) : null);
    on(row, 'click', () => { if (enabled) { close(); runCommand(app, command.id); } });
    pop.append(row);
  }
  for (const e of extra ?? []) {
    const row = el('div', { class: 'menu-row' }, el('span', { text: e.label }));
    on(row, 'click', () => { close(); e.run(); });
    pop.append(row);
  }

  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 3}px`;
  document.body.append(pop);
  const pr = pop.getBoundingClientRect();
  if (pr.right > window.innerWidth - 6) pop.style.left = `${window.innerWidth - pr.width - 6}px`;
  if (pr.bottom > window.innerHeight - 6) pop.style.top = `${Math.max(6, r.top - pr.height - 3)}px`;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}

export { clear };
