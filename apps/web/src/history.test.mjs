import test from 'node:test';
import assert from 'node:assert/strict';
import * as history from './history.ts';

test('reconnected history replaces stale reactions, preserves earlier messages and deduplicates confirmations', () => {
  const old = [{ id: 5, reactions: [] }, { id: 8, reactions: [] }];
  const changed = [{ id: 8, reactions: [{ emoji: '👍', count: 2 }] }, { id: 10, reactions: [] }];
  assert.deepEqual(history.mergeMessages?.(old, changed), [
    { id: 5, reactions: [] }, { id: 8, reactions: [{ emoji: '👍', count: 2 }] }, { id: 10, reactions: [] },
  ]);
});

test('older page does not overwrite newer reactions already seen during live sync', () => {
  const live = [{ id: 8, reactions: [{ emoji: '👍', count: 2 }] }];
  const page = [{ id: 3, reactions: [] }, { id: 8, reactions: [] }];
  assert.deepEqual(history.prependMessages?.(live, page), [
    { id: 3, reactions: [] }, { id: 8, reactions: [{ emoji: '👍', count: 2 }] },
  ]);
});

test('paging keeps a reaction delivered while an older snapshot was in flight and leaves other history unloaded', () => {
  const current = [{ id: 50, reactions: [] }];
  const older = [{ id: 30, reactions: [] }, { id: 40, reactions: [] }];
  const live = new Map();
  history.rememberPageChanges?.(live, [
    { id: 7, reactions: [{ emoji: '😢', count: 2 }] },
    { id: 40, reactions: [{ emoji: '🔥', count: 1 }] },
    { id: 90, reactions: [] },
  ], 50, 100);
  const result = history.prependMessages(current, older, live, 99);
  assert.deepEqual(result, [
    { id: 30, reactions: [] },
    { id: 40, reactions: [{ emoji: '🔥', count: 1 }] },
    { id: 50, reactions: [] },
  ]);
});

test('the in-flight history cache holds only the nearest page of changed older messages', () => {
  const live = new Map();
  const changed = Array.from({ length: 65 }, (_, index) => ({ id: index + 1 }));
  history.rememberPageChanges?.(live, changed.reverse(), 61, 100);
  assert.equal(live.size, 40);
  assert.equal(Math.min(...live.keys()), 21);
  assert.equal(Math.max(...live.keys()), 60);
});

test('a page snapshot newer than an in-flight change keeps the latest reaction', () => {
  const live = new Map();
  history.rememberPageChanges?.(live, [{ id: 8, reactions: [] }], 10, 120);
  const page = [{ id: 8, reactions: [{ emoji: '👍', count: 1 }] }];
  assert.deepEqual(history.prependMessages([], page, live, 121), [{ id: 8, reactions: [{ emoji: '👍', count: 1 }] }]);
});
