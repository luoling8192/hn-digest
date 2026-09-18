import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { configSchema } from '../src/config.js';
import type { Draft, HackerNewsItem, Summary } from '../src/domain.js';
import type { DigestDependencies, Runtime } from '../src/application/digest-service.js';
import { DigestService } from '../src/application/digest-service.js';
import { silentLogger } from '../src/logger.js';
import { SqlitePublicationRepository } from '../src/storage/sqlite-publication-repository.js';

export const config: Config = configSchema.parse({
  TELEGRAM_BOT_TOKEN: 'test-token-not-a-real-token',
  TELEGRAM_CHAT_ID: '-100123456789',
  OPENROUTER_API_KEY: 'test-key-not-a-real-key',
  TELEGRAPH_ACCESS_TOKEN: 'test-telegraph',
  ADMIN_TOKEN: 'x'.repeat(32),
});

export const story: HackerNewsItem = {
  id: 123,
  type: 'story',
  title: 'A & B < C',
  time: 100,
  score: 200,
  descendants: 10,
  url: 'https://example.com/article',
  kids: [124],
};

export const summary: Summary = {
  title: '中文 & <标题>',
  tags: ['AI', '编程语言'],
  quickTake: '一句话 <结论>',
  whyItMatters: ['解决具体问题', '展示新的方向'],
  readIf: '关注 AI 编程',
  skipIf: '只需要成熟工具',
  introduction: '摘要导语',
  article: [{ heading: '背景', paragraphs: ['主要内容'] }],
  discussion: [{ heading: '不同看法', text: '用户补充', commentIds: [124] }],
};

export const draft: Draft = {
  story,
  article: { text: 'Article text', source: 'article', readingMinutes: 3 },
  comments: [{ id: 124, parent: 123, author: 'alice', text: 'A useful correction' }],
  summary,
  generatedAt: '2026-09-18T00:00:00.000Z',
  commentCount: 10,
  commentHash: 'initial',
};

export interface Harness {
  directory: string;
  repository: SqlitePublicationRepository;
  dependencies: DigestDependencies;
  service: DigestService;
  runtime: Runtime & { advance(milliseconds: number): void };
  sends(): number;
  cleanup(): void;
}

export function createHarness(overrides: Partial<DigestDependencies> = {}): Harness {
  const directory = mkdtempSync(join(process.cwd(), 'data-test-'));
  const repository = new SqlitePublicationRepository(directory);
  let sends = 0;
  let now = Date.parse('2026-09-18T00:00:00.000Z');
  let ids = 0;
  const runtime = {
    now: () => now,
    createId: () => `lease-${++ids}`,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
  const dependencies: DigestDependencies = {
    getTopStories: async () => [story],
    getItem: async () => story,
    extractArticle: async () => draft.article,
    collectComments: async () => draft.comments,
    summarize: async () => structuredClone(draft),
    savePage: async (_generatedDraft, existing) =>
      existing ?? { path: 'test-09-18', url: 'https://telegra.ph/test-09-18' },
    sendMessage: async () => {
      sends += 1;
      return 42;
    },
    editMessage: async () => {},
    ...overrides,
  };
  const service = new DigestService(config, repository, dependencies, silentLogger, runtime);

  return {
    directory,
    repository,
    dependencies,
    service,
    runtime,
    sends: () => sends,
    cleanup: () => {
      repository.close();
      rmSync(directory, { recursive: true });
    },
  };
}
