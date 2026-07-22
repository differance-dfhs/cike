import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ISLAND_SIZE,
  ISLAND_EXPANDED_WIDTH,
  displayHasCameraHousing,
  islandBounds,
  isExpandedIslandMode,
  normalizeIslandMode,
} from './island-layout.mjs';

test('dormant island masks the full hardware strip around a MacBook notch', () => {
  assert.deepEqual(ISLAND_SIZE.dormant, { width: 472, height: 32 });
  assert.deepEqual(ISLAND_SIZE.glance, { width: 472, height: 78 });
  assert.equal(ISLAND_EXPANDED_WIDTH, 472);
  assert.equal(isExpandedIslandMode('dormant'), false);
  assert.equal(isExpandedIslandMode('glance'), false);
});

test('content modes are centered at the physical top edge', () => {
  assert.deepEqual(
    islandBounds({
      bounds: { x: 120, y: 0, width: 1512, height: 982 },
      workArea: { x: 120, y: 24, width: 1512, height: 958 },
      internal: false,
    }, 'suggestion'),
    { x: 640, y: 0, width: 472, height: 356 },
  );
  assert.equal(isExpandedIslandMode('suggestion'), true);
  assert.equal(isExpandedIslandMode('codex'), true);
});

test('unknown modes fail closed to dormant', () => {
  assert.equal(normalizeIslandMode('huge-dashboard'), 'dormant');
  assert.deepEqual(
    islandBounds({
      bounds: { x: 0, y: 24, width: 1440, height: 900 },
      workArea: { x: 0, y: 48, width: 1440, height: 876 },
      internal: false,
    }, 'huge-dashboard'),
    { x: 484, y: 24, width: 472, height: 32 },
  );
});

test('notched internal displays reserve the camera housing only while expanded', () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
    workArea: { x: 0, y: 32, width: 1470, height: 924 },
    internal: true,
  };
  assert.equal(displayHasCameraHousing(display), true);
  assert.deepEqual(islandBounds(display, 'dormant'), { x: 499, y: 0, width: 472, height: 32 });
  assert.deepEqual(islandBounds(display, 'suggestion'), { x: 499, y: 0, width: 472, height: 388 });
});

test('all modes preserve one native width and the same physical center', () => {
  const display = {
    bounds: { x: -1512, y: 0, width: 1512, height: 982 },
    workArea: { x: -1512, y: 24, width: 1512, height: 958 },
    internal: false,
  };
  const dormant = islandBounds(display, 'dormant');
  const suggestion = islandBounds(display, 'suggestion');
  const codex = islandBounds(display, 'codex');
  assert.equal(dormant.x + dormant.width / 2, suggestion.x + suggestion.width / 2);
  assert.equal(suggestion.x + suggestion.width / 2, codex.x + codex.width / 2);
  assert.equal(dormant.width, codex.width);
});

test('expanded island accepts its content height and only clamps at the physical display edge', () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
    workArea: { x: 0, y: 32, width: 1470, height: 924 },
    internal: true,
  };
  assert.deepEqual(islandBounds(display, 'suggestion', 452), { x: 499, y: 0, width: 472, height: 484 });
  assert.deepEqual(islandBounds(display, 'suggestion', 2_000), { x: 499, y: 0, width: 472, height: 956 });
});

test('every surface fills the native window without side seams', () => {
  for (const mode of ['dormant', 'glance', 'empty', 'suggestion', 'codex']) {
    assert.equal(ISLAND_SIZE[mode].width, ISLAND_EXPANDED_WIDTH);
  }
});
