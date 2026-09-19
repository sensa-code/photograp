let counter = 0;

/**
 * Short unique id. Lives in its own module so the model files can share it
 * without importing each other in a cycle.
 */
export const uid = (prefix = 'l'): string =>
  `${prefix}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
