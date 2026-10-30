import type { Comment, Draft, Publication } from '../domain.js';
import { isScanCardSummary } from '../domain.js';
import { hackerNewsUrl } from '../adapters/hacker-news.js';
import { originalUrl } from '../presentation.js';
import type { PublicationRepository } from '../storage/publication-repository.js';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

export type Block =
  | { type: 'heading'; level: 2; text: string }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'image'; url: string; caption: string | null }
  | { type: 'quote'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; language: string | null; text: string };

export interface ArticleSummary {
  id: number;
  title: string;
  overview: string;
  score: number;
  commentCount: number;
  readingMinutes: number | null;
  publishedAt: string;
  coverImageUrl: string | null;
  sourceUrl: string | null;
  hnUrl: string;
  tags: string[];
}

export interface DiscussionSection {
  heading: string | null;
  inlines: Inline[];
  citations: Array<{ number: number; commentId: number; author: string | null; url: string }>;
}

export interface ArticleDetail extends ArticleSummary {
  bodyKind: 'rewrite' | 'summary';
  body: Block[];
  discussion: DiscussionSection[];
  generatedAt: string;
  aiGenerated: true;
  disclaimer: string;
  pageUrl: string;
}

export const rewriteDisclaimer = '本文为 AI 生成的中文改写，请以原文为准。';
export const summaryDisclaimer = '本文由 AI 生成，请结合原文及评论核对。';

export function isReadable(publication: Publication): boolean {
  return (
    publication.state === 'published' &&
    publication.page !== null &&
    publication.draft.article.source !== 'unavailable'
  );
}

export function publishedAtMs(publication: Publication): number {
  return publication.publishedAt ?? (publication.draft.story.time || 0) * 1000;
}

export function summaryOf(publication: Publication): ArticleSummary {
  const { story, summary, article } = publication.draft;
  const _raw = story.url;
  return {
    id: publication.id,
    title: summary.title,
    overview: isScanCardSummary(summary) ? summary.quickTake : summary.introduction,
    score: story.score ?? 0,
    commentCount: story.descendants ?? publication.draft.commentCount,
    readingMinutes: article.readingMinutes,
    publishedAt: new Date(publishedAtMs(publication)).toISOString(),
    coverImageUrl: article.media?.coverImage ?? null,
    sourceUrl: story.url && /^https?:\/\//i.test(story.url) ? originalUrl(publication.draft) : null,
    hnUrl: hackerNewsUrl(story.id),
    tags: isScanCardSummary(summary) ? summary.tags : [],
  };
}

export function inlines(text: string): Inline[] {
  return text
    .split(/(`[^`\n]+`)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 2
        ? { type: 'code', text: part.slice(1, -1) }
        : { type: 'text', text: part },
    );
}

export function detailOf(publication: Publication): ArticleDetail {
  const draft = publication.draft;
  const { summary } = draft;
  const rewrite = 'rewrite' in summary ? summary.rewrite : undefined;
  const cover = draft.article.media?.coverImage ?? null;
  const images = new Map(draft.article.media?.images.map((image) => [image.id, image]));
  const body: Block[] = [];
  const seen = new Set<string>();
  if (rewrite) {
    for (const section of rewrite.sections) {
      if (section.heading) body.push({ type: 'heading', level: 2, text: section.heading });
      for (const text of section.paragraphs)
        body.push({ type: 'paragraph', inlines: inlines(text) });
      for (const id of section.imageIds) {
        const image = images.get(id);
        if (!image || image.url === cover || seen.has(image.url)) continue;
        seen.add(image.url);
        body.push({ type: 'image', url: image.url, caption: image.caption || null });
      }
    }
  } else {
    if ('introduction' in summary)
      body.push({ type: 'paragraph', inlines: inlines(summary.introduction) });
    else if ('quickTake' in summary)
      body.push({ type: 'paragraph', inlines: inlines(summary.quickTake) });
    for (const section of summary.article) {
      if (section.heading) body.push({ type: 'heading', level: 2, text: section.heading });
      for (const text of section.paragraphs)
        body.push({ type: 'paragraph', inlines: inlines(text) });
    }
  }
  return {
    ...summaryOf(publication),
    bodyKind: rewrite ? 'rewrite' : 'summary',
    body,
    discussion: discussionOf(draft),
    generatedAt: draft.generatedAt,
    aiGenerated: true,
    disclaimer: rewrite ? rewriteDisclaimer : summaryDisclaimer,
    pageUrl: publication.page?.url ?? '',
  };
}

function discussionOf(draft: Draft): DiscussionSection[] {
  const authors = new Map<number, Comment['author']>(
    draft.comments.map((comment) => [comment.id, comment.author]),
  );
  const numbers = new Map<number, number>();
  return draft.summary.discussion.map((section) => ({
    heading: 'heading' in section ? section.heading : null,
    inlines: inlines(section.text),
    citations: [...new Set(section.commentIds)].map((commentId) => {
      const number = numbers.get(commentId) ?? numbers.size + 1;
      numbers.set(commentId, number);
      return {
        number,
        commentId,
        author: authors.get(commentId) ?? null,
        url: hackerNewsUrl(commentId),
      };
    }),
  }));
}

// Sorted index of readable publications, cached briefly because each listing
// would otherwise parse every stored publication (comments included).
export class ArticleIndex {
  private cached: { at: number; items: Publication[] } | null = null;

  constructor(
    private readonly repository: Pick<PublicationRepository, 'listPublications' | 'getPublication'>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 15_000,
  ) {}

  list(): Publication[] {
    const now = this.now();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.items;
    const items = this.repository
      .listPublications()
      .filter(isReadable)
      .sort((a, b) => publishedAtMs(b) - publishedAtMs(a) || b.id - a.id);
    this.cached = { at: now, items };
    return items;
  }

  get(id: number): Publication | null {
    const publication = this.repository.getPublication(id);
    return publication && isReadable(publication) ? publication : null;
  }
}

export function encodeCursor(time: number, id: number): string {
  return Buffer.from(`${time}.${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { time: number; id: number } | null {
  const match = Buffer.from(cursor, 'base64url')
    .toString()
    .match(/^(\d{1,16})\.([1-9]\d{0,15})$/);
  return match ? { time: Number(match[1]), id: Number(match[2]) } : null;
}

// Returns items strictly after the cursor in descending (time, id) order.
export function page<T>(
  items: T[],
  key: (item: T) => { time: number; id: number },
  cursor: { time: number; id: number } | null,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const rest = cursor
    ? items.filter((item) => {
        const { time, id } = key(item);
        return time < cursor.time || (time === cursor.time && id < cursor.id);
      })
    : items;
  const selected = rest.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected,
    nextCursor: last && rest.length > limit ? encodeCursor(key(last).time, key(last).id) : null,
  };
}
