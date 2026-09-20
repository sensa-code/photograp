import { ADJUSTMENT_LABELS } from '../filters/adjustments';
import { FILTER_GROUPS } from '../filters/registry';
import type { AdjustmentSpec } from '../core/types';

export type MenuEntry =
  | { kind: 'cmd'; id: string }
  | { kind: 'sep' }
  | { kind: 'sub'; label: string; items: MenuEntry[] };

export const cmdEntry = (id: string): MenuEntry => ({ kind: 'cmd', id });
const sep: MenuEntry = { kind: 'sep' };
const sub = (label: string, items: MenuEntry[]): MenuEntry => ({ kind: 'sub', label, items });

const ADJUST_ORDER: AdjustmentSpec['type'][] = [
  'brightness-contrast', 'levels', 'curves', 'exposure',
  'vibrance', 'hue-saturation', 'color-balance', 'black-white',
  'photo-filter', 'channel-mixer', 'selective-color', 'gradient-map',
  'shadows-highlights',
  'invert', 'posterize', 'threshold',
];

const adjustItems = (prefix: 'adjust' | 'adjustLayer'): MenuEntry[] =>
  ADJUST_ORDER.map((t) => cmdEntry(`${prefix}.${t}`));

const filterMenu = (): MenuEntry[] => [
  cmdEntry('filter.repeat'),
  sep,
  cmdEntry('filter.liquify'),
  sep,
  ...FILTER_GROUPS().map((g) => sub(g.group, g.items.map((f) => cmdEntry(`filter.${f.id}`)))),
];

export const MENUS: { label: string; items: MenuEntry[] }[] = [
  {
    label: '檔案',
    items: [
      cmdEntry('file.new'),
      cmdEntry('file.open'),
      cmdEntry('file.place'),
      sep,
      cmdEntry('file.save'),
      cmdEntry('file.saveAs'),
      cmdEntry('file.export'),
      cmdEntry('file.exportPng'),
      sep,
      cmdEntry('file.close'),
    ],
  },
  {
    label: '編輯',
    items: [
      cmdEntry('edit.undo'),
      cmdEntry('edit.redo'),
      cmdEntry('history.snapshot'),
      sep,
      cmdEntry('edit.cut'),
      cmdEntry('edit.copy'),
      cmdEntry('edit.copyMerged'),
      cmdEntry('edit.paste'),
      cmdEntry('edit.clear'),
      sep,
      cmdEntry('edit.fill'),
      cmdEntry('edit.fillHistory'),
      cmdEntry('edit.contentAwareFill'),
      cmdEntry('edit.fillFg'),
      cmdEntry('edit.fillBg'),
      cmdEntry('edit.stroke'),
      cmdEntry('edit.definePattern'),
      sep,
      cmdEntry('edit.transform'),
      cmdEntry('edit.contentAwareScale'),
      sub('變形', [
        cmdEntry('edit.flipLayerH'),
        cmdEntry('edit.flipLayerV'),
      ]),
    ],
  },
  {
    label: '影像',
    items: [
      cmdEntry('image.size'),
      cmdEntry('image.canvas'),
      sep,
      sub('影像旋轉', [
        cmdEntry('image.rotate90'),
        cmdEntry('image.rotate-90'),
        cmdEntry('image.rotate180'),
        sep,
        cmdEntry('image.flipH'),
        cmdEntry('image.flipV'),
      ]),
      cmdEntry('image.cropToSelection'),
      cmdEntry('image.trim'),
      sep,
      sub('調整', adjustItems('adjust')),
      sep,
      cmdEntry('image.autoTone'),
      cmdEntry('image.autoContrast'),
    ],
  },
  {
    label: '圖層',
    items: [
      cmdEntry('layer.new'),
      cmdEntry('layer.duplicate'),
      cmdEntry('layer.delete'),
      sep,
      sub('新增調整圖層', adjustItems('adjustLayer')),
      sub('圖層遮色片', [
        cmdEntry('layer.maskReveal'),
        cmdEntry('layer.maskHide'),
        cmdEntry('layer.maskSelection'),
        sep,
        cmdEntry('layer.maskApply'),
        cmdEntry('layer.maskDelete'),
      ]),
      cmdEntry('layer.clip'),
      cmdEntry('layer.style'),
      cmdEntry('layer.shapeOptions'),
      sub('文字', [
        cmdEntry('text.onPath'),
        cmdEntry('text.offPath'),
      ]),
      sep,
      sub('智慧型物件', [
        cmdEntry('smart.convert'),
        sep,
        cmdEntry('smart.transform'),
        cmdEntry('smart.filters'),
        cmdEntry('smart.reset'),
        sep,
        cmdEntry('smart.edit'),
        cmdEntry('smart.commit'),
        cmdEntry('smart.replace'),
      ]),
      sep,
      cmdEntry('layer.rasterize'),
      cmdEntry('layer.group'),
      sub('排列順序', [
        cmdEntry('layer.up'),
        cmdEntry('layer.down'),
      ]),
      sub('圖層構成', [
        cmdEntry('comp.new'),
        cmdEntry('comp.apply'),
        cmdEntry('comp.update'),
        cmdEntry('comp.delete'),
      ]),
      sub('對齊與分佈', [
        cmdEntry('layer.alignLeft'),
        cmdEntry('layer.alignCenterH'),
        cmdEntry('layer.alignRight'),
        { kind: 'sep' },
        cmdEntry('layer.alignTop'),
        cmdEntry('layer.alignCenterV'),
        cmdEntry('layer.alignBottom'),
        { kind: 'sep' },
        cmdEntry('layer.distributeH'),
        cmdEntry('layer.distributeV'),
      ]),
      sep,
      cmdEntry('layer.mergeDown'),
      cmdEntry('layer.mergeVisible'),
      cmdEntry('layer.flatten'),
    ],
  },
  {
    label: '選取',
    items: [
      cmdEntry('select.all'),
      cmdEntry('select.none'),
      cmdEntry('select.inverse'),
      cmdEntry('select.refineEdge'),
      sep,
      sub('修改', [
        cmdEntry('select.border'),
        cmdEntry('select.smooth'),
        cmdEntry('select.expand'),
        cmdEntry('select.contract'),
        cmdEntry('select.feather'),
      ]),
      sep,
      cmdEntry('select.colorRange'),
      cmdEntry('select.fromLayer'),
      cmdEntry('select.fromMask'),
      sep,
      cmdEntry('path.makeSelection'),
      cmdEntry('path.fromSelection'),
      sep,
      cmdEntry('channel.saveSelection'),
      cmdEntry('channel.loadSelection'),
      sep,
      cmdEntry('quickmask.toggle'),
      cmdEntry('quickmask.options'),
      cmdEntry('quickmask.toChannel'),
    ],
  },
  { label: '濾鏡', items: filterMenu() },
  {
    label: '檢視',
    items: [
      cmdEntry('view.zoomIn'),
      cmdEntry('view.zoomOut'),
      cmdEntry('view.fit'),
      cmdEntry('view.actual'),
      sep,
      cmdEntry('view.rulers'),
      cmdEntry('view.grid'),
      cmdEntry('view.guides'),
      sep,
      cmdEntry('view.snap'),
      sub('靠齊至', [
        cmdEntry('view.snapGuides'),
        cmdEntry('view.snapGrid'),
        cmdEntry('view.snapDocument'),
        cmdEntry('view.snapLayers'),
      ]),
      sep,
      sub('參考線', [
        cmdEntry('view.newGuide'),
        cmdEntry('view.guidesFromSelection'),
        cmdEntry('view.lockGuides'),
        cmdEntry('view.clearGuides'),
      ]),
      cmdEntry('view.gridSize'),
    ],
  },
  {
    label: '說明',
    items: [
      cmdEntry('help.shortcuts'),
      cmdEntry('help.about'),
    ],
  },
];

export const ADJUSTMENT_MENU_ORDER = ADJUST_ORDER;
export const ADJUSTMENT_TITLES = ADJUSTMENT_LABELS;
