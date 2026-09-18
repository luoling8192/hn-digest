import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readyPublication } from '../src/domain.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';
import { draft } from './fixtures.js';

test('SQLite failures apply bounded exponential retry delays', () => {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-'));
  const repository = new SqlitePublicationRepository(directory);
  try {
    const now = 1_000_000;
    repository.recordFailure(draft.story.id, 'first', now);
    assert.equal(repository.retryAllowed(draft.story.id, now), false);
    assert.equal(repository.retryAllowed(draft.story.id, now + 600_000), true);

    repository.recordFailure(draft.story.id, 'second', now);
    const [failure] = repository.listFailures();
    assert.equal(failure?.attempts, 2);
    assert.equal(failure?.nextRetry, now + 1_200_000);
    assert.equal(failure?.code, 'second');
  } finally {
    repository.close();
    rmSync(directory, { recursive: true });
  }
});

test('SQLite reads validate persisted publication JSON', () => {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-'));
  const repository = new SqlitePublicationRepository(directory);
  repository.savePublication(readyPublication(draft, 1));
  repository.close();

  const database = new DatabaseSync(join(directory, 'digest.sqlite'));
  database.prepare('UPDATE publications SET data = ? WHERE id = ?').run('{broken', draft.story.id);
  database.close();

  const reopened = new SqlitePublicationRepository(directory);
  try {
    assert.throws(() => reopened.getPublication(draft.story.id), /not valid JSON/);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true });
  }
});

test('SQLite refuses schema versions newer than this application understands', () => {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-'));
  const database = new DatabaseSync(join(directory, 'digest.sqlite'));
  database.exec('PRAGMA user_version=2');
  database.close();

  try {
    assert.throws(
      () => new SqlitePublicationRepository(directory),
      /Unsupported database schema version 2/,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
