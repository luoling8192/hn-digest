import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { fetchArticle } from './article.js';
import { collectComments, commentsHash, frontPage, getItem } from './hn.js';
import { errorCode, log } from './http.js';
import { editMessage, savePage, sendMessage, TelegramRejected } from './publish.js';
import { messageHash } from './render.js';
import { Store } from './store.js';
import { summarize } from './summarize.js';
import type { Article, Comment, Draft, Item, Page, Publication } from './types.js';

export interface Dependencies {
  frontPage(): Promise<Item[]>; getItem(id: number): Promise<Item | null>;
  article(item: Item): Promise<Article>; comments(item: Item): Promise<Comment[]>;
  summarize(item: Item, article: Article, comments: Comment[]): Promise<Draft>;
  page(draft: Draft, page: Page | null): Promise<Page>;
  send(draft: Draft, page: Page): Promise<number>;
  edit(draft: Draft, page: Page, messageId: number): Promise<void>;
}
export function dependencies(config: Config): Dependencies {
  return { frontPage, getItem, article: fetchArticle, comments: collectComments,
    summarize: (s, a, c) => summarize(config, s, a, c),
    page: (d, p) => savePage(config, d, p), send: (d, p) => sendMessage(config, d, p), edit: (d, p, m) => editMessage(config, d, p, m) };
}
export class Worker {
  busy = false;
  lastCycle: { finishedAt: string; published: number; updated: number; failed: number } | null = null;
  constructor(readonly config: Config, readonly store: Store, readonly deps: Dependencies) {}
  enabled() { const setting = this.store.setting('auto_publish'); return setting === null ? this.config.AUTO_PUBLISH : setting === 'true'; }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    if (this.busy || !this.store.acquire(owner)) throw new Error('Worker already running');
    this.busy = true;
    const timer = setInterval(() => this.store.renew(owner), 30_000);
    try {
      for (const item of this.store.all()) if (item.state === 'sending') this.store.put({ ...item, state: 'uncertain' });
      return await work();
    } finally { clearInterval(timer); this.store.release(owner); this.busy = false; }
  }
  async build(story: Item): Promise<Draft> {
    if (story.type !== 'story' || story.dead || story.deleted || !story.title) throw new Error('Not a readable HN story');
    const [article, comments] = await Promise.all([this.deps.article(story), this.deps.comments(story)]);
    if (article.source === 'unavailable' && !comments.length) throw new Error('No source material available');
    return this.deps.summarize(story, article, comments);
  }
  async preview(id: number, regenerate = false): Promise<Draft> {
    return this.exclusive(async () => {
      const existing = this.store.get(id);
      if (existing && !regenerate) return existing.draft;
      if (existing && regenerate && (existing.state !== 'ready' || existing.page)) throw new Error('Cannot regenerate a delivered or partially delivered draft');
      const story = await this.deps.getItem(id);
      if (!story) throw new Error('Story not found');
      const draft = await this.build(story);
      this.store.prepare(draft);
      return draft;
    });
  }
  async publish(id: number): Promise<Publication> {
    return this.exclusive(async () => {
      let item = this.store.get(id);
      if (!item) {
        const story = await this.deps.getItem(id);
        if (!story) throw new Error('Story not found');
        item = this.store.prepare(await this.build(story));
      }
      return this.deliver(item);
    });
  }
  async deliver(item: Publication): Promise<Publication> {
    if (item.state === 'published') return item;
    if (item.state !== 'ready') throw new Error('Delivery uncertain: reconcile before retrying');
    if (!item.page) { item.page = await this.deps.page(item.draft, null); this.store.put(item); }
    item.state = 'sending';
    this.store.put(item);
    try { item.messageId = await this.deps.send(item.draft, item.page); }
    catch (error) {
      item.state = error instanceof TelegramRejected ? 'ready' : 'uncertain';
      this.store.put(item);
      throw error;
    }
    item.state = 'published';
    item.publishedAt = Date.now(); item.updatedAt = Date.now();
    item.messageHash = messageHash(item.draft, item.page.url);
    this.store.put(item); this.store.clearFailure(item.id);
    log('published', { storyId: item.id, messageId: item.messageId, page: item.page.url });
    return item;
  }
  async refresh(item: Publication, story: Item): Promise<boolean> {
    if (!item.page || item.messageId === null || item.state !== 'published') return false;
    let draft = { ...item.draft, story };
    const since = Date.now() - item.updatedAt;
    if ((story.descendants ?? 0) - item.draft.commentCount >= this.config.COMMENT_UPDATE_THRESHOLD
      && since >= 3600_000 && item.updates < this.config.MAX_COMMENT_UPDATES) {
      const comments = await this.deps.comments(story);
      if (commentsHash(comments) !== item.draft.commentHash) {
        draft = await this.deps.summarize(story, item.draft.article, comments);
        await this.deps.page(draft, item.page);
        item.updates++;
        item.updatedAt = Date.now();
        item.draft = draft;
        this.store.put(item);
      }
    }
    const hash = messageHash(draft, item.page.url);
    if (hash !== item.messageHash) { await this.deps.edit(draft, item.page, item.messageId); item.messageHash = hash; }
    item.draft = draft; this.store.put(item); this.store.clearFailure(item.id);
    return true;
  }
  async cycle(): Promise<void> {
    await this.exclusive(async () => {
      const result = { finishedAt: '', published: 0, updated: 0, failed: 0 };
      const stories = await this.deps.frontPage();
      const byId = new Map(stories.map(s => [s.id, s]));
      let attempted = 0;
      for (const story of stories) {
        if ((story.score ?? 0) < this.config.MIN_SCORE || !this.store.retryAllowed(story.id)) continue;
        const existing = this.store.get(story.id);
        if (existing && existing.state !== 'ready') continue;
        if (attempted >= this.config.MAX_NEW_PER_CYCLE) break;
        attempted++;
        try {
          await this.deliver(existing ?? this.store.prepare(await this.build(story)));
          result.published++;
        } catch (error) { this.store.fail(story.id, errorCode(error)); result.failed++; log('publication_failed', { storyId: story.id, code: errorCode(error) }); }
      }
      for (const item of this.store.all().filter(p => p.state === 'published' && p.publishedAt !== null && Date.now() - p.publishedAt < 48 * 3600_000)) {
        if (!this.store.retryAllowed(item.id)) continue;
        try {
          const story = byId.get(item.id) ?? await this.deps.getItem(item.id);
          if (story && !story.dead && !story.deleted && await this.refresh(item, story)) result.updated++;
        } catch (error) { this.store.fail(item.id, errorCode(error)); result.failed++; log('refresh_failed', { storyId: item.id, code: errorCode(error) }); }
      }
      result.finishedAt = new Date().toISOString(); this.lastCycle = result;
      this.store.setSetting('last_cycle', JSON.stringify(result));
      log('cycle_finished', { published: result.published, updated: result.updated, failed: result.failed });
    });
  }
}
