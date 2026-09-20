import type { HackerNewsClient } from '../adapters/hacker-news.js';
import type { OpenRouterSummarizer } from '../adapters/openrouter-summarizer.js';
import type { TelegraphClient } from '../adapters/telegraph.js';
import type { ReadingArticle } from './model.js';
import type { ReadingStore } from './store.js';
import type { Logger } from '../logger.js';
import { errorCode } from '../errors.js';

export interface DeepReader {
  prepare(article: ReadingArticle): Promise<ReadingArticle>;
  enqueue?(articles: ReadingArticle[], onReady: () => Promise<void>): void;
}

export class DeepReading implements DeepReader {
  private readonly inFlight = new Map<number, Promise<ReadingArticle>>();
  private readonly pending: { article: ReadingArticle; onReady: () => Promise<void> }[] = [];
  private readonly active = new Set<Promise<void>>();
  private stopped = false;
  constructor(
    private readonly store: ReadingStore,
    private readonly hn: Pick<HackerNewsClient, 'getItem' | 'collectComments'>,
    private readonly summarizer: Pick<OpenRouterSummarizer, 'summarize'>,
    private readonly telegraph: Pick<TelegraphClient, 'save'>,
    private readonly logger: Logger,
  ) {}

  async prepare(article: ReadingArticle): Promise<ReadingArticle> {
    const cached = this.store.article(article.id);
    if (cached?.summaryUrl) return cached;
    const existing = this.inFlight.get(article.id);
    if (existing) return existing;
    const operation = this.generate(article);
    this.inFlight.set(article.id, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(article.id);
    }
  }

  enqueue(articles: ReadingArticle[], onReady: () => Promise<void>): void {
    if (this.stopped) return;
    for (const article of articles) {
      if (article.summaryUrl || this.pending.length >= 10) continue;
      this.pending.push({ article, onReady });
    }
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
    await Promise.all(this.active);
    await Promise.allSettled(this.inFlight.values());
  }

  private pump(): void {
    while (!this.stopped && this.active.size < 2 && this.pending.length) {
      const job = this.pending.shift();
      if (!job) break;
      const operation = this.prepare(job.article)
        .then(() => job.onReady())
        .catch((error) => {
          this.logger.warn('reading_deep_page_failed', {
            storyId: job.article.id,
            code: errorCode(error),
          });
        })
        .finally(() => {
          this.active.delete(operation);
          this.pump();
        });
      this.active.add(operation);
    }
  }

  private async generate(article: ReadingArticle): Promise<ReadingArticle> {
    if (article.summaryUrl) return article;
    const source = this.store.source(article.id);
    if (!source || source.source === 'unavailable') return article;
    const story = await this.hn.getItem(article.id);
    if (!story || story.deleted || story.dead) return article;
    const comments = await this.hn.collectComments(story);
    const draft = await this.summarizer.summarize(story, source, comments, []);
    const page = await this.telegraph.save(draft, null);
    const updated = { ...article, summaryUrl: page.url };
    this.store.saveArticle(updated);
    return updated;
  }
}
