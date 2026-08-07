import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkArray, mapPool } from '@/lib/async-pool';

test('chunkArray splits into fixed-size batches', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([], 10), []);
  assert.deepEqual(chunkArray(['a'], 50), [['a']]);
});

test('mapPool preserves order with concurrency', async () => {
  const started: number[] = [];
  const results = await mapPool(
    [10, 20, 30, 40, 50],
    2,
    async (value, index) => {
      started.push(index);
      await new Promise((resolve) => setTimeout(resolve, 5 - index));
      return value * 2;
    },
  );
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
  assert.equal(started.length, 5);
});

test('mapPool reports progress as items complete', async () => {
  const progress: Array<[number, number]> = [];
  await mapPool(
    ['a', 'b', 'c'],
    2,
    async (value) => value.toUpperCase(),
    (completed, total) => progress.push([completed, total]),
  );
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});
