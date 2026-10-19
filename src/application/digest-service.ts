import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import type {
  Article,
  Comment,
  CycleResult,
  Draft,
  HackerNewsItem,
  Page,
  Publication,
  TagFrequency,
} from '../domain.js';
import {
  articleSchema,
  cycleResultSchema,
  isReusableTag,
  isScanCardSummary,
  readyPublication,
} from '../domain.js';
import {
  ApplicationError,
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
const DISCUSSION_SETTLE_INTERVAL_MS = 12 * 3_600_000;
const DISCUSSION_GROWTH_RATIO = 0.2;
const TAG_EXAMPLE_LIMIT = 2;
const ARTICLE_RECOVERY_LIMIT = 3;
const ARTICLE_RECOVERY_RETRY_MS = 600_000;
const articleRecoverySchema = z.object({
  attempts: z.number().int().nonnegative(),
  lastAttempt: z.number().nonnegative(),
  nextRetry: z.number().nonnegative(),
  article: articleSchema.nullable(),
  lastError: z.string().nullable().default(null),
});
type ArticleRecovery = z.infer<typeof articleRecoverySchema>;

function recoveryKey(id: number): string {
  return `article_recovery:${id}`;
}

function articleHost(publication: Publication): string {
  try {
    return new URL(publication.draft.story.url ?? 'https://news.ycombinator.com').hostname;
  } catch {
    return 'invalid-url';
  }
}

export interface DigestDependencies {
  getTopStories(): Promise<HackerNewsItem[]>;
  getItem(id: number): Promise<HackerNewsItem | null>;
  extractArticle(story: HackerNewsItem): Promise<Article>;
  collectComments(story: HackerNewsItem): Promise<Comment[]>;
  summarize(
    story: HackerNewsItem,
    article: Article,
    comments: Comment[],
    tagCatalog: readonly TagFrequency[],
  ): Promise<Draft>;
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
  private work: { stage: string; storyId: number | null } | null = null;

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

  currentWork() {
    return this.work ? { ...this.work } : null;
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

  articleRecoveries() {
    return this.repository.listPublications().flatMap((publication) => {
      if (publication.state !== 'published') return [];
      const stored = this.repository.getSetting(recoveryKey(publication.id));
      if (!stored && publication.draft.article.source !== 'unavailable') return [];
      const state = stored ? articleRecoverySchema.parse(JSON.parse(stored)) : null;
      return [
        {
          id: publication.id,
          attempts: state?.attempts ?? 0,
          nextRetry: state?.nextRetry ?? 0,
          code: state?.lastError ?? null,
          phase: publication.draft.article.source === 'unavailable' ? 'source' : 'message',
        },
      ];
    });
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
      this.work = { stage: '获取 HN 热门文章', storyId: null };
      const stories = await this.dependencies.getTopStories();
      this.logger.info('candidates_scanned', {
        count: stories.length,
        minScore: this.config.MIN_SCORE,
        maxAttempts: this.config.MAX_NEW_PER_CYCLE,
      });
      const topStories = new Map(stories.map((story) => [story.id, story]));
      let attempted = 0;

      for (const story of stories) {
        const now = this.runtime.now();
        const existing = this.repository.getPublication(story.id);
        const reason =
          (story.score ?? 0) < this.config.MIN_SCORE
            ? 'below_score'
            : !this.repository.retryAllowed(story.id, now)
              ? 'retry_backoff'
              : existing && existing.state !== 'ready'
                ? existing.state
                : attempted >= this.config.MAX_NEW_PER_CYCLE
                  ? 'cycle_limit'
                  : 'selected';
        this.logger.info('candidate_evaluated', {
          storyId: story.id,
          rank: stories.indexOf(story) + 1,
          score: story.score ?? 0,
          reason,
        });
        if (reason !== 'selected') continue;
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

      const recovery = await this.recoverArticles();
      result.updated += recovery.updated;
      result.failed += recovery.failed;
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
        if (recovery.handled.has(publication.id)) continue;
        if (!this.repository.retryAllowed(publication.id, this.runtime.now())) continue;
        try {
          this.work = { stage: '更新已发布文章', storyId: publication.id };
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
      this.work = null;
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

    this.work = { stage: '提取正文与读取评论', storyId: story.id };
    const [article, comments] = await Promise.all([
      this.dependencies.extractArticle(story),
      this.dependencies.collectComments(story),
    ]);
    if (article.source === 'unavailable' && comments.length === 0) throw new UnreadableStoryError();
    this.work = { stage: '生成中文摘要', storyId: story.id };
    return this.dependencies.summarize(story, article, comments, this.tagCatalog());
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
      this.work = { stage: '保存 Telegraph 页面', storyId: publication.id };
      const page = await this.dependencies.savePage(current.draft, null);
      current = { ...current, page };
      this.repository.savePublication(current);
    }
    const page = current.page;
    if (!page) throw new Error('Publication page was not persisted');

    const sending: Publication = { ...current, state: 'sending' };
    this.work = { stage: '发送 Telegram 消息', storyId: publication.id };
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
    if (published.draft.article.source === 'unavailable') {
      this.repository.setSetting(
        recoveryKey(published.id),
        JSON.stringify({
          attempts: 0,
          lastAttempt: now,
          nextRetry: now + ARTICLE_RECOVERY_RETRY_MS,
          article: null,
          lastError: null,
        } satisfies ArticleRecovery),
      );
    }
    this.logger.info('published', {
      storyId: published.id,
      messageId,
      page: page.url,
    });
    return published;
  }

  private async recoverArticles(): Promise<{
    updated: number;
    failed: number;
    handled: Set<number>;
  }> {
    const result = { updated: 0, failed: 0, handled: new Set<number>() };
    const now = this.runtime.now();
    const candidates: { publication: Publication; state: ArticleRecovery }[] = [];
    for (const publication of this.repository.listPublications()) {
      if (publication.state !== 'published' || !publication.page || publication.messageId === null)
        continue;
      const stored = this.repository.getSetting(recoveryKey(publication.id));
      if (publication.draft.article.source !== 'unavailable' && !stored) continue;
      const state = stored
        ? articleRecoverySchema.parse(JSON.parse(stored))
        : { attempts: 0, lastAttempt: 0, nextRetry: 0, article: null, lastError: null };
      // An unfinished Telegram edit must retain this independent recovery backoff.
      if (publication.draft.article.source !== 'unavailable') result.handled.add(publication.id);
      if (state.nextRetry <= now) candidates.push({ publication, state });
    }
    candidates.sort(
      (left, right) =>
        left.state.lastAttempt - right.state.lastAttempt ||
        left.publication.id - right.publication.id,
    );
    const selected: typeof candidates = [];
    const hosts = new Set<string>();
    for (const candidate of candidates) {
      const host = articleHost(candidate.publication);
      if (hosts.has(host)) continue;
      hosts.add(host);
      selected.push(candidate);
      if (selected.length === ARTICLE_RECOVERY_LIMIT) break;
    }
    for (const candidate of candidates) {
      if (selected.length === ARTICLE_RECOVERY_LIMIT) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }

    for (const { publication, state: previous } of selected) {
      this.work = { stage: '恢复缺失正文', storyId: publication.id };
      result.handled.add(publication.id);
      const attempts = previous.attempts + 1;
      let state: ArticleRecovery = {
        ...previous,
        attempts,
        lastAttempt: this.runtime.now(),
        nextRetry:
          this.runtime.now() +
          Math.min(6 * 3_600_000, ARTICLE_RECOVERY_RETRY_MS * 2 ** Math.min(attempts - 1, 6)),
      };
      // Persist before remote work so an interrupted worker also respects backoff.
      this.repository.setSetting(recoveryKey(publication.id), JSON.stringify(state));
      let phase = 'extract';
      try {
        let current = publication;
        if (current.draft.article.source === 'unavailable') {
          const article =
            state.article ?? (await this.dependencies.extractArticle(current.draft.story));
          if (article.source === 'unavailable')
            throw new ApplicationError(
              article.failureCode ?? 'article_recovery_unavailable',
              502,
              'Article remains unavailable',
            );
          state = { ...state, article };
          this.repository.setSetting(recoveryKey(publication.id), JSON.stringify(state));
          phase = 'summarize';
          const draft = await this.dependencies.summarize(
            current.draft.story,
            article,
            current.draft.comments,
            this.tagCatalog(),
          );
          phase = 'save_page';
          const page = await this.dependencies.savePage(draft, current.page);
          current = { ...current, draft, page, updatedAt: this.runtime.now() };
          this.repository.savePublication(current);
        }
        const page = current.page;
        const messageId = current.messageId;
        if (!page || messageId === null)
          throw new Error('Published delivery identifiers are missing');
        phase = 'edit_message';
        const messageHash = telegramMessageHash(current.draft, page.url);
        if (messageHash !== current.messageHash) {
          await this.dependencies.editMessage(current.draft, page, messageId);
          this.repository.savePublication({ ...current, messageHash });
        }
        this.repository.setSetting(recoveryKey(publication.id), '');
        this.repository.clearFailure(publication.id);
        result.updated += 1;
        this.logger.info('article_recovered', { storyId: publication.id, attempts });
      } catch (error) {
        this.repository.setSetting(
          recoveryKey(publication.id),
          JSON.stringify({ ...state, lastError: errorCode(error) }),
        );
        result.failed += 1;
        this.logger.warn('article_recovery_failed', {
          storyId: publication.id,
          phase,
          code: errorCode(error),
          attempts,
          nextRetry: state.nextRetry,
        });
      }
    }
    return result;
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
    const relativeCommentGrowth =
      publication.draft.commentCount === 0 ? 0 : newCommentCount / publication.draft.commentCount;
    const hasMaterialGrowth =
      newCommentCount >= this.config.COMMENT_UPDATE_THRESHOLD ||
      (publication.draft.commentCount >= this.config.COMMENT_UPDATE_THRESHOLD &&
        relativeCommentGrowth >= DISCUSSION_GROWTH_RATIO);
    const hasUnsettledComments =
      newCommentCount > 0 && now - publication.updatedAt >= DISCUSSION_SETTLE_INTERVAL_MS;
    const shouldRegenerateDiscussion =
      (hasMaterialGrowth || hasUnsettledComments) &&
      now - publication.updatedAt >= DISCUSSION_REFRESH_INTERVAL_MS &&
      publication.updates < this.config.MAX_COMMENT_UPDATES;

    if (shouldRegenerateDiscussion) {
      const comments = await this.dependencies.collectComments(story);
      if (hashComments(comments) !== publication.draft.commentHash) {
        const draft = await this.dependencies.summarize(
          story,
          publication.draft.article,
          comments,
          this.tagCatalog(),
        );
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

  private tagCatalog(): TagFrequency[] {
    const catalog = new Map<string, TagFrequency>();
    for (const publication of this.repository.listPublications()) {
      const summary = publication.draft.summary;
      if (!isScanCardSummary(summary)) continue;
      for (const tag of new Set(summary.tags)) {
        if (!isReusableTag(tag)) continue;
        const entry = catalog.get(tag) ?? { tag, uses: 0, examples: [] };
        entry.uses += 1;
        if (entry.examples.length < TAG_EXAMPLE_LIMIT && !entry.examples.includes(summary.title)) {
          entry.examples.push(summary.title);
        }
        catalog.set(tag, entry);
      }
    }

    return [...catalog.values()]
      .sort((left, right) => right.uses - left.uses || left.tag.localeCompare(right.tag, 'zh-CN'))
      .slice(0, 100)
      .sort((left, right) => left.tag.localeCompare(right.tag, 'zh-CN'));
  }
}
