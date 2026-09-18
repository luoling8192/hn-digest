import { ArticleExtractor } from './adapters/article-extractor.js';
import { HackerNewsClient } from './adapters/hacker-news.js';
import { OpenRouterSummarizer } from './adapters/openrouter-summarizer.js';
import { TelegraphClient } from './adapters/telegraph.js';
import { TelegramClient } from './adapters/telegram.js';
import { createAdminServer } from './admin-server.js';
import { DigestService, type DigestDependencies } from './application/digest-service.js';
import { DigestScheduler } from './application/scheduler.js';
import { readConfig } from './config.js';
import { FetchJsonHttpClient } from './http-client.js';
import { jsonLogger } from './logger.js';
import { SqlitePublicationRepository } from './storage/sqlite-publication-repository.js';

const config = readConfig();
const repository = new SqlitePublicationRepository(config.DATA_DIR);
const http = new FetchJsonHttpClient();
const hackerNews = new HackerNewsClient(http);
const articleExtractor = new ArticleExtractor(jsonLogger);
const summarizer = new OpenRouterSummarizer(config, http, jsonLogger);
const telegraph = new TelegraphClient(config, http);
const telegram = new TelegramClient(config);

const dependencies: DigestDependencies = {
  getTopStories: () => hackerNews.getTopStories(),
  getItem: (id) => hackerNews.getItem(id),
  extractArticle: (story) => articleExtractor.extract(story),
  collectComments: (story) => hackerNews.collectComments(story),
  summarize: (story, article, comments) => summarizer.summarize(story, article, comments),
  savePage: (draft, existing) => telegraph.save(draft, existing),
  sendMessage: (draft, page) => telegram.send(draft, page),
  editMessage: (draft, page, messageId) => telegram.edit(draft, page, messageId),
};

const service = new DigestService(config, repository, dependencies, jsonLogger);
const scheduler = new DigestScheduler(service, config.POLL_INTERVAL_SECONDS * 1_000, jsonLogger);
let stopping = false;
const server = createAdminServer({
  adminToken: config.ADMIN_TOKEN,
  service,
  logger: jsonLogger,
  stopping: () => stopping,
});
server.requestTimeout = 180_000;
server.listen(config.PORT, '0.0.0.0', () => {
  jsonLogger.info('server_started', {
    port: config.PORT,
    autoPublish: service.automaticPublishingEnabled(),
  });
  scheduler.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  scheduler.stop();
  jsonLogger.info('shutdown_started', { signal });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  const deadline = Date.now() + 170_000;
  while (service.isRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const drained = !service.isRunning;
  if (drained) repository.close();
  jsonLogger.info('shutdown_finished', { drained });
}
