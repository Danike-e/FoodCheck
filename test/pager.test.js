import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageWindow } from '../public/js/pager.js';

test('pageWindow shows first, last, current ± 1 with gaps', () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 2), [1, 2]);
  assert.deepEqual(pageWindow(1, 27), [1, 2, null, 27]);
  assert.deepEqual(pageWindow(3, 27), [1, 2, 3, 4, null, 27]);
  assert.deepEqual(pageWindow(5, 27), [1, null, 4, 5, 6, null, 27]);
  assert.deepEqual(pageWindow(25, 27), [1, null, 24, 25, 26, 27]);
  assert.deepEqual(pageWindow(27, 27), [1, null, 26, 27]);
  assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5]);
});

test('pageWindow never shows more than 7 items', () => {
  for (let total = 1; total <= 60; total++) {
    for (let cur = 1; cur <= total; cur++) assert.ok(pageWindow(cur, total).length <= 7, `${cur}/${total}`);
  }
});
