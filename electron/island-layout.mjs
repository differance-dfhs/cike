export const ISLAND_MODES = Object.freeze([
  'dormant',
  'glance',
  'empty',
  'suggestion',
  'codex',
]);

export const ISLAND_SIZE = Object.freeze({
  dormant: Object.freeze({ width: 472, height: 32 }),
  glance: Object.freeze({ width: 472, height: 78 }),
  empty: Object.freeze({ width: 472, height: 120 }),
  suggestion: Object.freeze({ width: 472, height: 356 }),
  codex: Object.freeze({ width: 472, height: 380 }),
});

// Every surface uses the same native width. Dormant mode paints the full width
// black so the underlying menu bar cannot create pale "shoulders", while the
// visible controls remain centered around the camera housing.
export const ISLAND_EXPANDED_WIDTH = 472;

export function normalizeIslandMode(value, fallback = 'dormant') {
  return ISLAND_MODES.includes(value) ? value : fallback;
}

export function isExpandedIslandMode(mode) {
  return mode === 'empty' || mode === 'suggestion' || mode === 'codex';
}

export function displayHasCameraHousing(display) {
  const topInset = Math.max(0, Number(display?.workArea?.y) - Number(display?.bounds?.y));
  return display?.internal === true && topInset >= 30;
}

export function islandBounds(display, rawMode, requestedContentHeight) {
  const mode = normalizeIslandMode(rawMode);
  const size = ISLAND_SIZE[mode];
  const reserve = mode === 'dormant' || !displayHasCameraHousing(display) ? 0 : 32;
  const requested = Number(requestedContentHeight);
  const contentHeight = isExpandedIslandMode(mode) && Number.isFinite(requested) && requested > 0
    ? Math.max(size.height, Math.round(requested))
    : size.height;
  const displayHeight = Math.max(1, Number(display?.bounds?.height) || contentHeight + reserve);
  const height = Math.min(displayHeight, contentHeight + reserve);
  return {
    x: display.bounds.x + Math.round((display.bounds.width - size.width) / 2),
    y: display.bounds.y,
    width: size.width,
    height,
  };
}
