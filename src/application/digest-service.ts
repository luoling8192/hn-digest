import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type {
  Article,
  Comment,
  CycleResult,
  Draft,
  HackerNewsItem,
  Page,
  Publication,
} from '../domain.js';
import { cycleResultSchema, readyPublication } from '../domain.js';
import {
  ConcurrentRunError,
  DeliveryRejectedError,
  PublicationConflictError,
  StoryNotFoundError,
  UnreadableStoryError,
  errorCode,
} from '../errors.js';
import type { Logger } from '../logger.js';
import { hashComments } from '../adapters/hacker-news.js';
import { telegramMessageHash } from '../presentation.js';
import type { PublicationRepository } from '../storage/publication-repository.js';

const LEASE_DURATION_MS = 300_000;
const LEASE_RENEWAL_MS = 30_000;
const REFRESH_WINDOW_MS = 48 * 3_600_000;
const DISCUSSION_REFRESH_INTERVAL_MS = 3_600_000;

export interface DigestDependencies {
  getTopStories(): Promise<HackerNewsItem[]>;
  getItem(id: number): Promise<HackerNewsItem | null>;
  extractArticle(story: HackerNewsItem): Promise<Article>;
  collectComments(story: HackerNewsItem): Promise<Comment[]>;
  summarize(story: HackerNewsItem, article: Article, comments: Comment[]): Promise<Draft>;
  savePage(draft: Draft, existing: Page | null): Promise<Page>;
  sendMessage(draft: Draft, page: Page): Promise<number>;
  editMessage(draft: Draft, page: Page, messageId: number): Promise<void>;
}

export interface Runtime {
  now(): number;
  createId(): string;
}

const systemRuntime: Runtime = {
  now: () => Date.now(),
  createId: () => randomUUID(),
};

export class DigestService {
  private running = false;
  private mostRecentCycle: CycleResult | null = null;

  constructor(
    private readonly config: Config,
    private readonly repository: PublicationRepository,
    private readonly dependencies: DigestDependencies,
    private readonly logger: Logger,
    private readonly runtime: Runtime = systemRuntime,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  automaticPublishingEnabled(): boolean {
    const stored = this.repository.getSetting('auto_publish');
    return stored === null ? this.config.AUTO_PUBLISH : stored === 'true';
  }

  setAutomaticPublishing(enabled: boolean): void {
    this.repository.setSetting('auto_publish', String(enabled));
  }

  lastCycle(): CycleResult | null {
    if (this.mostRecentCycle) return this.mostRecentCycle;
    const stored = this.repository.getSetting('last_cycle');
    if (!stored) return null;
    try {
      return cycleResultSchema.parse(JSON.parse(stored));
    } catch {
      this.logger.warn('stored_cycle_invalid');
      return null;
    }
  }

  publications(): Publication[] {
    return this.repository.listPublications();
  }

  failures() {
    return this.repository.listFailures();
  }

  async preview(id: number, regenerate = false): Promise<Draft> {
    return this.runExclusive(async () => {
      const existing = this.repository.getPublication(id);
      if (existing && !regenerate) return existing.draft;
      if (existing && (existing.state !== 'ready' || existing.page)) {
        throw new PublicationConflictError(
          'Cannot regenerate a delivered or partially delivered draft',
        );
      }

      const story = await this.requireStory(id);
      const draft = await this.buildDraft(story);
      this.repository.savePublication(readyPublication(draft, this.runtime.now()));
      return draft;
    });
  }

  async publish(id: number): Promise<Publication> {
    return this.runExclusive(async () => {
      let publication = this.repository.getPublication(id);
      if (!publication) {
        const story = await this.requireStory(id);
        publication = readyPublication(await this.buildDraft(story), this.runtime.now());
        this.repository.savePublication(publication);
      }
      return this.deliver(publication);
    });
  }

  async runCycle(): Promise<CycleResult> {
    return this.runExclusive(async () => {
      const result = { published: 0, updated: 0, failed: 0 };
      const stories = await this.dependencies.getTopStories();
      const topStories = new Map(stories.map((story) => [story.id, story]));
      let attempted = 0;

      for (const story of stories) {
        const now = this.runtime.now();
        if ((story.score ?? 0) < this.config.MIN_SCORE) continue;
        if (!this.repository.retryAllowed(story.id, now)) continue;

        const existing = this.repository.getPublication(story.id);
        if (existing && existing.state !== 'ready') continue;
        if (attempted >= this.config.MAX_NEW_PER_CYCLE) break;
        attempted += 1;

        try {
          const publication = existing ?? readyPublication(await this.buildDraft(story), now);
          if (!existing) this.repository.savePublication(publication);
          await this.deliver(publication);
          result.published += 1;
        } catch (error) {
          this.repository.recordFailure(story.id, errorCode(error), this.runtime.now());
          result.failed += 1;
          this.logger.error('publication_failed', { storyId: story.id, code: errorCode(error) });
        }
      }

      const now = this.runtime.now();
      const recent = this.repository
        .listPublications()
        .filter(
          (publication) =>
            publication.state === 'published' &&
            publication.publishedAt !== null &&
            now - publication.publishedAt < REFRESH_WINDOW_MS,
        );

      for (const publication of recent) {
        if (!this.repository.retryAllowed(publication.id, this.runtime.now())) continue;
        try {
          const story =
            topStories.get(publication.id) ?? (await this.dependencies.getItem(publication.id));
          if (story && !story.dead && !story.deleted) {
            await this.refresh(publication, story);
            result.updated += 1;
          }
        } catch (error) {
          this.repository.recordFailure(publication.id, errorCode(error), this.runtime.now());
          result.failed += 1;
          this.logger.error('refresh_failed', { storyId: publication.id, code: errorCode(error) });
        }
      }

      const cycle: CycleResult = {
        ...result,
        finishedAt: new Date(this.runtime.now()).toISOString(),
      };
      this.mostRecentCycle = cycle;
      this.repository.setSetting('last_cycle', JSON.stringify(cycle));
      this.logger.info('cycle_finished', result);
      return cycle;
    });
  }

  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const owner = this.runtime.createId();
    const now = this.runtime.now();
    if (this.running || !this.repository.acquireLease(owner, now, LEASE_DURATION_MS)) {
      throw new ConcurrentRunError();
    }

    this.running = true;
    const renewal = setInterval(
      () => this.repository.renewLease(owner, this.runtime.now(), LEASE_DURATION_MS),
      LEASE_RENEWAL_MS,
    );
    renewal.unref();

    try {
      this.recoverInterruptedDeliveries();
      return await work();
    } finally {
      clearInterval(renewal);
      this.repository.releaseLease(owner);
      this.running = false;
    }
  }

  private recoverInterruptedDeliveries(): void {
    for (const publication of this.repository.listPublications()) {
      if (publication.state !== 'sending') continue;
      this.repository.savePublication({ ...publication, state: 'uncertain' });
      this.logger.warn('delivery_recovered_as_uncertain', { storyId: publication.id });
    }
  }

  private async requireStory(id: number): Promise<HackerNewsItem> {
    const story = await this.dependencies.getItem(id);
    if (!story) throw new StoryNotFoundError();
    return story;
  }

  private async buildDraft(story: HackerNewsItem): Promise<Draft> {
    if (story.type !== 'story' || story.dead || story.deleted || !story.title) {
      throw new UnreadableStoryError('The Hacker News item is not a readable story');
    }

    const [article, comments] = await Promise.all([
      this.dependencies.extractArticle(story),
      this.dependencies.collectComments(story),
    ]);
    if (article.source === 'unavailable' && comments.length === 0) throw new UnreadableStoryError();
    return this.dependencies.summarize(story, article, comments);
  }

  private async deliver(publication: Publication): Promise<Publication> {
    if (publication.state === 'published') return publication;
    if (publication.state !== 'ready') {
      throw new PublicationConflictError(
        'Delivery outcome is uncertain and requires reconciliation',
      );
    }

    let current = publication;
    if (!current.page) {
      const page = await this.dependencies.savePage(current.draft, null);
      current = { ...current, page };
      this.repository.savePublication(current);
    }
    const page = current.page;
    if (!page) throw new Error('Publication page was not persisted');

    const sending: Publication = { ...current, state: 'sending' };
    this.repository.savePublication(sending);
    let messageId: number;
    try {
      messageId = await this.dependencies.sendMessage(sending.draft, page);
    } catch (error) {
      const state = error instanceof DeliveryRejectedError ? 'ready' : 'uncertain';
      this.repository.savePublication({ ...sending, state });
      throw error;
    }

    const now = this.runtime.now();
    const published: Publication = {
      ...sending,
      state: 'published',
      messageId,
      publishedAt: now,
      updatedAt: now,
      messageHash: telegramMessageHash(sending.draft, page.url),
    };
    this.repository.savePublication(published);
    this.repository.clearFailure(published.id);
    this.logger.info('published', {
      storyId: published.id,
      messageId,
      page: page.url,
    });
    return published;
  }

  private async refresh(publication: Publication, story: HackerNewsItem): Promise<void> {
    if (!publication.page || publication.messageId === null || publication.state !== 'published')
      return;

    let current: Publication = {
      ...publication,
      draft: { ...publication.draft, story },
    };
    const now = this.runtime.now();
    const newCommentCount = (story.descendants ?? 0) - publication.draft.commentCount;
    const shouldRegenerateDiscussion =
      newCommentCount >= this.config.COMMENT_UPDATE_THRESHOLD &&
      now - publication.updatedAt >= DISCUSSION_REFRESH_INTERVAL_MS &&
      publication.updates < this.config.MAX_COMMENT_UPDATES;

    if (shouldRegenerateDiscussion) {
      const comments = await this.dependencies.collectComments(story);
      if (hashComments(comments) !== publication.draft.commentHash) {
        const draft = await this.dependencies.summarize(story, publication.draft.article, comments);
        const page = await this.dependencies.savePage(draft, publication.page);
        current = {
          ...current,
          draft,
          page,
          updates: publication.updates + 1,
          updatedAt: now,
        };
        this.repository.savePublication(current);
      }
    }

    const page = current.page;
    const messageId = current.messageId;
    if (!page || messageId === null) throw new Error('Published delivery identifiers are missing');
    const messageHash = telegramMessageHash(current.draft, page.url);
    if (messageHash !== current.messageHash) {
      await this.dependencies.editMessage(current.draft, page, messageId);
      current = { ...current, messageHash };
    }

    this.repository.savePublication(current);
    this.repository.clearFailure(current.id);
  }
}
