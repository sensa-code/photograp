import type { App } from '../core/app';
import { PhotoDoc } from '../core/document';
import { createRasterLayer } from '../core/layer';
import { createSurface } from '../core/surface';
import { loadImageFile, loadProject } from '../io/files';
import { setTextEditorHook } from '../tools/draw';
import { clear, el, on, raf } from './dom';
import { icon } from './icons';
import { MenuBar } from './menubar';
import { ToolBar } from './toolbar';
import { OptionsBar } from './optionsbar';
import { CanvasView } from './canvas-view';
import { LayersPanel } from './panels/layers';
import { HistoryPanel } from './panels/history';
import { ColorPanel } from './panels/color';
import { NavigatorPanel } from './panels/navigator';
import { TextEditor } from './text-editor';
import { installShortcuts } from './shortcuts';
import { registerCommand, runCommand } from './commands';

/** Clicking a panel title collapses it, as in a docked panel group. */
function makePanelsCollapsible(container: HTMLElement): void {
  for (const head of container.querySelectorAll<HTMLElement>('.panel-head')) {
    const caret = el('span', { class: 'caret', html: icon('down', 12) });
    head.insertBefore(caret, head.firstChild);
    on(head, 'click', (ev) => {
      if ((ev.target as HTMLElement).closest('.tools')) return;
      head.parentElement?.classList.toggle('collapsed');
    });
  }
}

export class AppUI {
  readonly root: HTMLElement;
  private menubar: MenuBar;
  private tabbar: HTMLElement;
  private toolbar: ToolBar;
  private optionsbar: OptionsBar;
  private view: CanvasView;
  private statusLeft: HTMLElement;
  private statusRight: HTMLElement;
  private toasts: HTMLElement;
  private textEditor: TextEditor;

  constructor(private app: App) {
    this.menubar = new MenuBar(app);
    this.tabbar = el('div', { class: 'tabbar' });
    this.optionsbar = new OptionsBar(app);
    this.toolbar = new ToolBar(app);
    this.view = new CanvasView(app);
    this.textEditor = new TextEditor(app, this.view);

    const panels = el('div', { class: 'panels' },
      new NavigatorPanel(app, this.view).root,
      new ColorPanel(app).root,
      new HistoryPanel(app).root,
      new LayersPanel(app).root);
    makePanelsCollapsible(panels);

    this.statusLeft = el('div', { class: 'grow' });
    this.statusRight = el('div', {});
    const statusbar = el('div', { class: 'statusbar' },
      this.zoomBox(),
      el('div', { class: 'sep' }),
      this.sizeBox(),
      el('div', { class: 'sep' }),
      this.statusLeft,
      this.statusRight);

    this.toasts = el('div', { class: 'toasts' });

    this.root = el('div', { class: 'app' },
      this.menubar.root,
      this.tabbar,
      this.optionsbar.root,
      el('div', { class: 'workspace' }, this.toolbar.root, this.view.root, panels),
      statusbar);
    document.body.append(this.toasts);

    registerCommand({
      id: 'view.fit',
      label: '顯示全頁',
      shortcut: 'Ctrl+0',
      run: () => this.view.fitToWindow(),
      enabled: (a) => a.activeDoc() !== null,
    });

    setTextEditorHook((layer, doc) => this.textEditor.open(layer, doc));

    app.events.on('docs-changed', () => this.renderTabs());
    app.events.on('doc-changed', raf(() => { this.renderTabs(); this.renderStatus(); }));
    app.events.on('view-changed', raf(() => this.renderStatus()));
    app.events.on('tool-changed', () => this.menubar.refresh());
    app.events.on('options-changed', () => this.optionsbar.refresh());
    app.events.on('status', (text) => { this.statusRight.textContent = text; });
    app.events.on('toast', ({ text, kind }) => this.showToast(text, kind));

    installShortcuts(app, this.toolbar, this.view, this.textEditor);
    this.installDropTarget();
    this.installPaste();
    this.renderTabs();
    this.renderStatus();

    window.addEventListener('beforeunload', (ev) => {
      if (app.docs.some((d) => d.isDirty)) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  fitToWindow(): void { this.view.fitToWindow(); }

  private zoomBox(): HTMLElement {
    const input = el('input', {
      type: 'text', value: '100%', style: 'width:64px;text-align:right',
    }) as HTMLInputElement;
    on(input, 'change', () => {
      const v = parseFloat(input.value.replace('%', ''));
      if (!Number.isNaN(v)) this.view.zoomTo(Math.max(0.01, Math.min(32, v / 100)));
    });
    const fit = el('button', { class: 'mini-btn', html: icon('fit', 13), title: '顯示全頁 (Ctrl+0)' });
    on(fit, 'click', () => this.view.fitToWindow());
    this.app.events.on('view-changed', () => {
      if (document.activeElement !== input) {
        input.value = `${Math.round(this.app.view().zoom * 100)}%`;
      }
    });
    return el('div', { style: 'display:flex;gap:5px;align-items:center' }, input, fit);
  }

  private sizeBox(): HTMLElement {
    const node = el('span', { text: '—' });
    const update = (): void => {
      const doc = this.app.activeDoc();
      node.textContent = doc
        ? `${doc.width} × ${doc.height} px  ·  ${doc.meta.dpi} dpi  ·  ${doc.allLayers().length} 個圖層`
        : '—';
    };
    this.app.events.on('doc-changed', update);
    this.app.events.on('docs-changed', update);
    update();
    return node;
  }

  private renderStatus(): void {
    const doc = this.app.activeDoc();
    if (!doc) { this.statusLeft.textContent = ''; return; }
    const sel = doc.selection.bounds();
    this.statusLeft.textContent = sel
      ? `選取範圍 ${sel.w} × ${sel.h} px  (${sel.x}, ${sel.y})`
      : (doc.activeLayer() ? `作用中：${doc.activeLayer()!.name}${doc.editingMask ? '（遮色片）' : ''}` : '');
  }

  private renderTabs(): void {
    clear(this.tabbar);
    for (const doc of this.app.docs) {
      const active = doc.meta.id === this.app.activeDocId;
      const tab = el('div', { class: `doc-tab${active ? ' active' : ''}` },
        el('span', { text: doc.meta.name }),
        doc.isDirty ? el('span', { class: 'dot', text: '●' }) : null,
        el('span', { class: 'x', html: icon('close', 12) }));
      on(tab, 'click', () => this.app.setActiveDoc(doc.meta.id));
      on(tab.querySelector('.x')!, 'click', (ev) => {
        ev.stopPropagation();
        this.app.setActiveDoc(doc.meta.id);
        runCommand(this.app, 'file.close');
      });
      this.tabbar.append(tab);
    }
    this.tabbar.append(el('div', { class: 'spacer' }));
    const add = el('div', { class: 'doc-tab', title: '開新檔案 (Ctrl+N)' }, el('span', { html: icon('plus', 13) }));
    on(add, 'click', () => runCommand(this.app, 'file.new'));
    this.tabbar.append(add);
  }

  private showToast(text: string, kind: 'info' | 'error' | 'success'): void {
    const node = el('div', { class: `toast ${kind}`, text });
    this.toasts.append(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 260);
    }, 2600);
  }

  private installDropTarget(): void {
    const stop = (ev: Event): void => { ev.preventDefault(); ev.stopPropagation(); };
    on(this.view.root, 'dragover', stop);
    on(this.view.root, 'drop', async (e) => {
      stop(e);
      const ev = e as DragEvent;
      const files = [...(ev.dataTransfer?.files ?? [])];
      for (const file of files) {
        try {
          if (file.name.endsWith('.pgraph')) {
            this.app.addDoc(await loadProject(await file.text()));
            continue;
          }
          const img = await loadImageFile(file);
          const doc = this.app.activeDoc();
          if (doc) {
            const surface = createSurface(doc.width, doc.height);
            surface.ctx.drawImage(img, 0, 0);
            const layer = createRasterLayer(
              file.name.replace(/\.[^.]+$/, ''), doc.width, doc.height, surface,
            );
            doc.insertLayerAbove(layer, doc.activeLayerId);
            doc.commit('置入影像');
            this.app.changed();
          } else {
            this.app.addDoc(PhotoDoc.fromImage(
              file.name.replace(/\.[^.]+$/, ''), img, img.naturalWidth, img.naturalHeight,
            ));
            this.view.fitToWindow();
          }
        } catch {
          this.app.toast('無法開啟拖曳的檔案', 'error');
        }
      }
    });
  }

  private installPaste(): void {
    window.addEventListener('paste', async (ev) => {
      const items = [...(ev.clipboardData?.items ?? [])];
      const imageItem = items.find((i) => i.type.startsWith('image/'));
      if (!imageItem) return;
      const blob = imageItem.getAsFile();
      if (!blob) return;
      ev.preventDefault();
      const img = await loadImageFile(blob);
      const doc = this.app.activeDoc();
      if (!doc) {
        this.app.addDoc(PhotoDoc.fromImage('貼上的影像', img, img.naturalWidth, img.naturalHeight));
        this.view.fitToWindow();
        return;
      }
      const surface = createSurface(doc.width, doc.height);
      surface.ctx.drawImage(img, 0, 0);
      const layer = createRasterLayer('貼上的圖層', doc.width, doc.height, surface);
      doc.insertLayerAbove(layer, doc.activeLayerId);
      doc.commit('貼上影像');
      this.app.changed();
    });
  }
}
