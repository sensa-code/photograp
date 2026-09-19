/** Stroke-based 24x24 icons, rendered inline so there is no icon dependency. */
const PATHS: Record<string, string> = {
  move: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  marquee: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M10 3h4M10 21h4M3 10v4M21 10v4',
  lasso: 'M5 14c0-4 3.5-7 7.5-7S20 10 20 13.5c0 2.5-2 4-3.5 4S14 16 14 15M7 15c-1.2 1-2 2.2-2 3.4 0 1.5 1.2 2.6 2.6 2.6 1.1 0 2-.6 2.4-1.6',
  polygon: 'M12 3l8 5.5-3 9.5H7L4 8.5 12 3z',
  wand: 'M5 19l9-9M15 9l1.5-1.5M13 4l.7 2M19 8l-2 .7M19.5 14.5l-2-.6M9 3.5l.6 2M4 9l2 .6M15.5 4.5l1 1.8',
  crop: 'M7 2v15h15M2 7h15v15',
  eyedropper: 'M15 3.5l5.5 5.5M18 4.5L9 13.5 7 19l5.5-2 9-9a2.1 2.1 0 0 0-3-3z',
  brush: 'M4 20c3 0 4-2 4-4l-1-1c-2 0-3 1.5-3 5zM8.5 15.5L18 6a2.1 2.1 0 0 1 3 3l-9.5 9.5',
  pencil: 'M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4zM15 6l3 3',
  eraser: 'M8 20h12M16 4l5 5-9 9H7l-3-3 12-11zM9 9l6 6',
  stamp: 'M6 21h12M7 17h10v-2a3 3 0 0 0-3-3h-4a3 3 0 0 0-3 3v2zM10 12V8a2 2 0 0 1 4 0v4',
  finger: 'M8 20V9a2 2 0 1 1 4 0v3l4 1.5c1.5.5 2 1.6 2 3V20M8 13H6a2 2 0 0 0 0 4h2',
  droplet: 'M12 3s6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 12 3 12 3z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  bucket: 'M5 11l6-6 7 7-6 6a2 2 0 0 1-3 0l-4-4a2 2 0 0 1 0-3zM11 5L9 3M19 15c0 1.2.9 2 2 2s2-.8 2-2-2-4-2-4-2 2.8-2 4z',
  gradient: 'M3 4h18v16H3zM3 12h18M3 8h18M3 16h18',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  shape: 'M3 3h8v8H3zM14.5 11a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM3 14h18l-4 7H7l-4-7z',
  hand: 'M8 13V6a1.6 1.6 0 1 1 3.2 0V11M11.2 11V5a1.6 1.6 0 0 1 3.2 0v6M14.4 11V7a1.6 1.6 0 0 1 3.2 0v8c0 3.3-2.7 6-6 6h-1a5 5 0 0 1-5-5v-3l-1.2-1.4a1.6 1.6 0 0 1 2.3-2.2L8 13',
  zoom: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.5-4.5M8 11h6M11 8v6',
  transform: 'M4 4h5v5H4zM15 4h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5zM9 6.5h6M6.5 9v6M17.5 9v6M9 17.5h6',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.5 6.3A9.8 9.8 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.2 8.1A16.7 16.7 0 0 0 2 12s3.6 6 10 6c1.4 0 2.6-.3 3.7-.7M9.9 9.9a3 3 0 0 0 4.2 4.2',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  mask: 'M4 4h16v16H4zM12 4v16M4 12h8',
  folder: 'M3 6h6l2 2h10v11H3z',
  adjust: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  fx: 'M5 20V9a4 4 0 0 1 4-4h1M4 12h6M13 9l6 11M19 9l-6 11',
  link: 'M9 15l6-6M10.5 6.5l1.8-1.8a3.5 3.5 0 1 1 5 5l-1.8 1.8M13.5 17.5l-1.8 1.8a3.5 3.5 0 1 1-5-5l1.8-1.8',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  undo: 'M9 14l-5-5 5-5M4 9h9a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9h-9a6 6 0 0 0 0 12h3',
  grid: 'M3 9h18M3 15h18M9 3v18M15 3v18',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  swap: 'M7 7h9l-3-3M17 17H8l3 3',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  chevron: 'M9 6l6 6-6 6',
};

export function icon(name: string, size = 18): string {
  const d = PATHS[name] ?? PATHS.shape;
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"><path d="${d}"/></svg>`;
}

export function iconEl(name: string, size = 18): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon-wrap';
  span.innerHTML = icon(name, size);
  return span;
}
