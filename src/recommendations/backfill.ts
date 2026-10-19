import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { looksLikeChallengePage } from '../adapters/article-quality.js';
import type { Article, HackerNewsItem } from '../domain.js';
import { errorCode } from '../errors.js';
import type { JsonHttpClient } from '../http-client.js';
import type { Logger } from '../logger.js';
import type { ReadingAssistant } from './assistant.js';
import { articleFromCandidate, inferTopics } from './catalog.js';
import { newReader, type Candidate, type ReadingArticle } from './model.js';
import type { ReadingStore } from './store.js';

const SOURCE_RETRY_INTERVAL_MS = 6 * 3_600_000;
const IDLE_INTERVAL_MS = 60_000;
const INVENTORY_HEARTBEAT_MS = 3_600_000;

const searchSchema = z.object({
  hits: z.array(
    z.object({
      objectID: z.string().regex(/^\d+$/),
      title: z.string().min(1),
      url: z.string().nullable().optional(),
      points: z.number().nullable(),
      num_comments: z.number().nullable(),
      created_at_i: z.number(),
    }),
  ),
});

interface Extractor {
  extract(story: HackerNewsItem): Promise<Article>;
}
const stateSchema = z.object({
  month: z.number().int().min(0).max(60),
  anchor: z.number(),
  lastStep: z.string().nullable(),
});

export class ReadingBackfill {
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private nextStepDelay = 1500;
  private inventoryLog: { indexed: number; parsed: number; failed: number; at: number } | null =
    null;
  constructor(
    private readonly store: ReadingStore,
    private readonly http: JsonHttpClient,
    private readonly extractor: Extractor,
    private readonly assistant: ReadingAssistant,
    private readonly ownerId: number,
    private readonly logger: Logger,
    private readonly target = 300,
    private readonly now: () => number = Date.now,
    private readonly pause: (milliseconds: number, signal: AbortSignal) => Promise<void> = (
      milliseconds,
      signal,
    ) => delay(milliseconds, undefined, { signal }),
  ) {}

  start(): void {
    if (!this.running) this.running = this.run();
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }
  status() {
    return {
      ...this.store.inventory(),
      target: this.desiredTarget(),
      indexMonths: this.state().month,
      lastStep: this.state().lastStep,
      running: this.running !== null && !this.abort.signal.aborted,
    };
  }

  private desiredTarget(): number {
    const reader = this.store.reader(this.ownerId);
    return Math.min(500, this.target + (reader?.seen.length ?? 0));
  }

  private state() {
    return (
      this.store.get('archive:state', stateSchema) ?? {
        month: 0,
        anchor: this.now(),
        lastStep: null,
      }
    );
  }

  async step(): Promise<boolean> {
    const state = this.state();
    if (state.month < 60) {
      this.nextStepDelay = 1500;
      const end = new Date(state.anchor);
      end.setUTCMonth(end.getUTCMonth() - state.month);
      const start = new Date(state.anchor);
      start.setUTCMonth(start.getUTCMonth() - state.month - 1);
      const url = new URL('https://hn.algolia.com/api/v1/search');
      url.search = new URLSearchParams({
        tags: 'story',
        hitsPerPage: '100',
        numericFilters: `points>=150,created_at_i>=${Math.floor(start.getTime() / 1000)},created_at_i<${Math.floor(end.getTime() / 1000)}`,
      }).toString();
      const result = searchSchema.parse(await this.http.request(url.href, 'hn_archive'));
      this.store.transaction(() => {
        for (const hit of result.hits) {
          const id = Number(hit.objectID);
          if (
            !Number.isSafeInteger(id) ||
            this.store.candidate(id) ||
            (hit.points ?? 0) < 150 ||
            !hit.url ||
            !/^https?:\/\//i.test(hit.url)
          )
            continue;
          this.store.saveCandidate({
            id,
            title: hit.title,
            url: hit.url,
            score: hit.points ?? 0,
            comments: hit.num_comments ?? 0,
            time: hit.created_at_i,
            topics: inferTopics(hit.title),
            status: 'pending',
            attemptedAt: null,
          });
        }
        this.store.put('archive:state', {
          ...state,
          month: state.month + 1,
          lastStep: new Date(this.now()).toISOString(),
        });
      });
      this.logger.info('reading_index_progress', {
        months: state.month + 1,
        indexed: this.store.inventory().indexed,
      });
      return false;
    }
    const inventory = this.store.inventory();
    const target = this.desiredTarget();
    const now = this.now();
    const candidates = this.store
      .candidates()
      .filter(
        (candidate) =>
          candidate.topics.length &&
          ((candidate.status === 'pending' && inventory.parsed < target) ||
            (candidate.status === 'failed' &&
              (candidate.attemptedAt === null ||
                now - candidate.attemptedAt >= SOURCE_RETRY_INTERVAL_MS))),
      );
    const existing = new Set(this.store.articles().map((article) => article.id));
    const topicCounts = inventory.topics;
    candidates.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'failed' ? -1 : 1;
      if (a.status === 'failed' && b.status === 'failed') {
        const oldestAttempt = (a.attemptedAt ?? 0) - (b.attemptedAt ?? 0);
        if (oldestAttempt !== 0) return oldestAttempt;
      }
      const priority = (candidate: Candidate) =>
        Math.min(...candidate.topics.map((topic) => topicCounts[topic] ?? 0));
      return priority(a) - priority(b) || b.score - a.score;
    });
    const chosen: Candidate[] = [];
    const limit = inventory.parsed < target ? Math.min(3, target - inventory.parsed) : 1;
    let retryChosen = false;
    for (const candidate of candidates) {
      if (existing.has(candidate.id) || (candidate.status === 'failed' && retryChosen)) continue;
      chosen.push(candidate);
      if (candidate.status === 'failed') retryChosen = true;
      if (chosen.length >= limit) break;
    }
    this.nextStepDelay = chosen.length ? 1500 : IDLE_INTERVAL_MS;
    if (chosen.length) {
      await Promise.all(chosen.map((candidate) => this.prepareCandidate(candidate)));
      this.store.put('archive:state', {
        ...this.state(),
        lastStep: new Date(this.now()).toISOString(),
      });
    }
    const latest = this.store.inventory();
    if (
      !this.inventoryLog ||
      latest.indexed !== this.inventoryLog.indexed ||
      latest.parsed !== this.inventoryLog.parsed ||
      latest.failed !== this.inventoryLog.failed ||
      this.now() - this.inventoryLog.at >= INVENTORY_HEARTBEAT_MS
    ) {
      const fields = { indexed: latest.indexed, parsed: latest.parsed, failed: latest.failed };
      this.logger.info('reading_inventory', fields);
      this.inventoryLog = { ...fields, at: this.now() };
    }
    return this.state().month >= 60 && latest.parsed >= target;
  }

  private async prepareCandidate(candidate: Candidate): Promise<void> {
    this.store.saveCandidate({ ...candidate, status: 'failed', attemptedAt: this.now() });
    const cached = this.store.source(candidate.id);
    let source: Article;
    if (cached && sourceRejectionCode(cached) === null) {
      source = cached;
    } else {
      try {
        source = await this.extractor.extract({
          id: candidate.id,
          type: 'story',
          title: candidate.title,
          url: candidate.url,
          time: candidate.time,
          kids: [],
        });
      } catch (error) {
        this.logger.warn('reading_article_fetch_failed', {
          storyId: candidate.id,
          code: errorCode(error),
        });
        return;
      }
    }
    if (this.abort.signal.aborted) return;
    const rejection = sourceRejectionCode(source);
    if (rejection) {
      this.logger.warn('reading_article_fetch_failed', { storyId: candidate.id, code: rejection });
      return;
    }
    this.store.saveSource(candidate.id, source);
    const reader = this.store.reader(this.ownerId) ?? newReader(this.ownerId);
    let article: ReadingArticle;
    try {
      const [annotated] = await this.assistant.annotate(
        [articleFromCandidate(candidate, source)],
        reader,
        new Map([[candidate.id, source]]),
      );
      if (!annotated) throw new Error('Missing archive article annotation');
      article = annotated;
    } catch (error) {
      this.logger.warn('reading_annotation_failed', {
        storyId: candidate.id,
        code: errorCode(error),
      });
      return;
    }
    this.store.transaction(() => {
      this.store.saveArticle(article);
      this.store.saveCandidate({ ...candidate, status: 'ready', attemptedAt: this.now() });
    });
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      let complete = false;
      let failed = false;
      try {
        complete = await this.step();
      } catch (error) {
        failed = true;
        this.logger.warn('reading_backfill_failed', { code: errorCode(error) });
      }
      try {
        await this.pause(
          complete ? 3_600_000 : failed ? IDLE_INTERVAL_MS : this.nextStepDelay,
          this.abort.signal,
        );
      } catch {
        break;
      }
    }
  }
}

export function looksBlocked(text: string): boolean {
  return looksLikeChallengePage(text);
}

function sourceRejectionCode(source: Article): string | null {
  if (source.source === 'unavailable') return source.failureCode ?? 'article_unavailable';
  if (source.text.length < 200) return 'article_text_insufficient';
  if (looksBlocked(source.text)) return 'article_challenge_page';
  return null;
}
