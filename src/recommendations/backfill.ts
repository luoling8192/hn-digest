import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Article, HackerNewsItem } from '../domain.js';
import { errorCode } from '../errors.js';
import type { JsonHttpClient } from '../http-client.js';
import type { Logger } from '../logger.js';
import type { ReadingAssistant } from './assistant.js';
import { articleFromCandidate, inferTopics } from './catalog.js';
import { newReader, type Candidate } from './model.js';
import type { ReadingStore } from './store.js';

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
  constructor(
    private readonly store: ReadingStore,
    private readonly http: JsonHttpClient,
    private readonly extractor: Extractor,
    private readonly assistant: ReadingAssistant,
    private readonly ownerId: number,
    private readonly logger: Logger,
    private readonly target = 300,
    private readonly now: () => number = Date.now,
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
    if (inventory.parsed < target) {
      const candidates = this.store
        .candidates()
        .filter(
          (candidate) =>
            candidate.topics.length &&
            (candidate.status === 'pending' ||
              (candidate.status === 'failed' &&
                this.now() - (candidate.attemptedAt ?? 0) > 7 * 86_400_000)),
        );
      const existing = new Set(this.store.articles().map((article) => article.id));
      const topicCounts = inventory.topics;
      candidates.sort((a, b) => {
        const priority = (candidate: Candidate) =>
          Math.min(...candidate.topics.map((topic) => topicCounts[topic] ?? 0));
        return priority(a) - priority(b) || b.score - a.score;
      });
      const chosen = candidates
        .filter((candidate) => !existing.has(candidate.id))
        .slice(0, Math.min(3, target - inventory.parsed));
      if (chosen.length) {
        const fetched = await Promise.all(
          chosen.map(async (candidate) => ({
            candidate,
            source:
              this.store.source(candidate.id) ??
              (await this.extractor.extract({
                id: candidate.id,
                type: 'story',
                title: candidate.title,
                url: candidate.url,
                time: candidate.time,
                kids: [],
              })),
          })),
        );
        await Promise.all(
          fetched.map(async ({ candidate, source }) => {
            if (this.abort.signal.aborted) return;
            if (
              source.source === 'unavailable' ||
              source.text.length < 200 ||
              looksBlocked(source.text)
            ) {
              this.store.saveCandidate({ ...candidate, status: 'failed', attemptedAt: this.now() });
              return;
            }
            this.store.saveSource(candidate.id, source);
            try {
              const [article] = await this.assistant.annotate(
                [articleFromCandidate(candidate, source)],
                this.store.reader(this.ownerId) ?? newReader(this.ownerId),
                new Map([[candidate.id, source]]),
              );
              if (!article) throw new Error('Missing archive article annotation');
              this.store.transaction(() => {
                this.store.saveArticle(article);
                this.store.saveCandidate({
                  ...candidate,
                  status: 'ready',
                  attemptedAt: this.now(),
                });
              });
            } catch (error) {
              this.logger.warn('reading_annotation_failed', {
                storyId: candidate.id,
                code: errorCode(error),
              });
              this.store.saveCandidate({ ...candidate, status: 'failed', attemptedAt: this.now() });
            }
          }),
        );
        this.store.put('archive:state', {
          ...this.state(),
          lastStep: new Date(this.now()).toISOString(),
        });
      }
    }
    const latest = this.store.inventory();
    this.logger.info('reading_inventory', {
      indexed: latest.indexed,
      parsed: latest.parsed,
      failed: latest.failed,
    });
    return this.state().month >= 60 && this.store.inventory().parsed >= target;
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
        await delay(complete ? 3_600_000 : failed ? 60_000 : 1500, undefined, {
          signal: this.abort.signal,
        });
      } catch {
        break;
      }
    }
  }
}

export function looksBlocked(text: string): boolean {
  return (
    /(?:just a moment|verify you are human|checking your browser|access denied|enable javascript and cookies to continue|captcha)/i.test(
      text.slice(0, 600),
    ) && text.length < 4000
  );
}
