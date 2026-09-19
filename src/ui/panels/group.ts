import { el, on } from '../dom';
import { icon } from '../icons';

export interface PanelTab {
  label: string;
  icon: string;
  root: HTMLElement;
}

/**
 * Dock several panels behind one tab strip, the way Photoshop groups
 * Layers / Channels / Paths. Only the active panel's body is rendered.
 */
export function panelTabs(tabs: PanelTab[], activeIndex = 0): HTMLElement {
  const buttons: HTMLButtonElement[] = [];
  const strip = el('div', { class: 'panel-head panel-tabstrip' });
  const body = el('div', { class: 'tab-body' });

  const select = (i: number): void => {
    buttons.forEach((b, k) => b.classList.toggle('active', k === i));
    tabs.forEach((t, k) => t.root.classList.toggle('active', k === i));
  };

  tabs.forEach((tab, i) => {
    const b = el('button', { class: 'tab', title: tab.label },
      el('span', { html: icon(tab.icon, 13) }),
      el('span', { text: tab.label })) as HTMLButtonElement;
    on(b, 'click', () => select(i));
    buttons.push(b);
    strip.append(b);
    body.append(tab.root);
  });

  select(activeIndex);
  return el('div', { class: 'panel grow panel-tabgroup' }, strip, body);
}
