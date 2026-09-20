import type { HackerNewsClient } from '../adapters/hacker-news.js';
import type { OpenRouterSummarizer } from '../adapters/openrouter-summarizer.js';
import type { TelegraphClient } from '../adapters/telegraph.js';
import type { ReadingArticle } from './model.js';
import type { ReadingStore } from './store.js';

export interface DeepReader {
  prepare(article: ReadingArticle): Promise<ReadingArticle>;
}

export class DeepReading implements DeepReader {
  constructor(
    private readonly store: ReadingStore,
    private readonly hn: HackerNewsClient,
    private readonly summarizer: OpenRouterSummarizer,
    private readonly telegraph: TelegraphClient,
  ) {}

  async prepare(article: ReadingArticle): Promise<ReadingArticle> {
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
