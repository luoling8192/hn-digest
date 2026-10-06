import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectComments } from '../src/adapters/hacker-news.js';
import type { HackerNewsItem } from '../src/domain.js';
import { story } from './fixtures.js';

test('busy discussions retain rebuttals and nested clarifications before exhausting top-level comments', async () => {
  const roots = Array.from({ length: 30 }, (_, index) => 200 + index);
  const requests: number[] = [];
  const comments = await collectComments(
    { ...story, kids: roots },
    async (id) => {
      requests.push(id);
      return {
        id,
        time: id,
        type: 'comment',
        by: 'participant',
        parent: id === 300 ? 200 : id === 301 ? 300 : story.id,
        text:
          id === 300
            ? 'This claim is incorrect'
            : id === 301
              ? 'Here is the clarification'
              : 'Initial claim',
        kids: id === 200 ? [300] : id === 300 ? [301] : [],
      };
    },
    { limit: 18 },
  );
  assert.equal(comments.length, 18);
  assert.ok(comments.some((comment) => comment.id === 300 && comment.parent === 200));
  assert.ok(comments.some((comment) => comment.id === 301 && comment.parent === 300));
  assert.ok(comments.filter((comment) => roots.includes(comment.id)).length >= 8);
  assert.equal(new Set(requests).size, requests.length);
});

test('reply traversal remains bounded with deleted parents, duplicates, and cycles', async () => {
  let requests = 0;
  const comments = await collectComments(
    story,
    async (id) => {
      requests++;
      return {
        id,
        time: id,
        type: 'comment',
        parent: id - 1,
        by: 'participant',
        deleted: true,
        kids: [id, id + 1, id + 1],
      };
    },
    { limit: 5 },
  );
  assert.deepEqual(comments, []);
  assert.equal(requests, 15);
});

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
