import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectComments } from '../src/adapters/hacker-news.js';
import type { HackerNewsItem } from '../src/domain.js';
import { story } from './fixtures.js';

test('comment collection skips removed text and retains reply relationships', async () => {
  const items: Record<number, HackerNewsItem> = {
    124: {
      id: 124,
      time: 1,
      type: 'comment',
      parent: 123,
      by: 'alice',
      text: '<p>First &amp; useful</p>',
      kids: [125, 126],
    },
    125: { id: 125, time: 2, type: 'comment', parent: 124, deleted: true, kids: [] },
    126: {
      id: 126,
      time: 3,
      type: 'comment',
      parent: 124,
      by: 'bob',
      text: 'Reply',
      kids: [],
    },
  };

  const comments = await collectComments(story, async (id) => items[id] ?? null);
  assert.deepEqual(
    comments.map((comment) => [comment.id, comment.parent]),
    [
      [124, 123],
      [126, 124],
    ],
  );
  assert.equal(comments[0]?.text, 'First & useful');
});

test('comment collection enforces the total character budget', async () => {
  const comments = await collectComments(
    { ...story, kids: [124, 125] },
    async (id) => ({
      id,
      time: id,
      type: 'comment',
      parent: 123,
      by: 'user',
      text: '1234567890',
      kids: [],
    }),
    { maxCharacters: 12, maxCommentCharacters: 10 },
  );

  assert.equal(comments.map((comment) => comment.text).join('').length, 12);
});
