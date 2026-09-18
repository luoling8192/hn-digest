import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimateReadingMinutes,
  isPublicAddress,
  parsePublicHttpUrl,
} from '../src/adapters/article-extractor.js';

test('article URL validation blocks local, metadata, private, and mapped private addresses', () => {
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '10.1.2.3',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ]) {
    assert.equal(isPublicAddress(address), false);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.throws(() => parsePublicHttpUrl('http://127.0.0.1/admin'));
  assert.throws(() => parsePublicHttpUrl('file:///etc/passwd'));
});

test('reading estimates combine Latin words and Han characters', () => {
  assert.equal(estimateReadingMinutes('word '.repeat(220)), 1);
  assert.equal(estimateReadingMinutes('字'.repeat(401)), 2);
});
