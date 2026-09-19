import type { App } from '../core/app';

/** A single menu / keyboard action. */
export interface Cmd {
  id: string;
  label: string;
  shortcut?: string;
  run: (app: App) => void | Promise<void>;
  enabled?: (app: App) => boolean;
  checked?: (app: App) => boolean;
}

export function cmd(
  id: string, label: string, run: Cmd['run'],
  extra: Partial<Omit<Cmd, 'id' | 'label' | 'run'>> = {},
): Cmd {
  return { id, label, run, ...extra };
}
