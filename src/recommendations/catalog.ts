import type { Article } from '../domain.js';
import { isScanCardSummary } from '../domain.js';
import type { PublicationRepository } from '../storage/publication-repository.js';
import type { Candidate, ReadingArticle } from './model.js';
import type { ReadingStore } from './store.js';

const topicPatterns: [string, RegExp][] = [
  [
    '架构',
    /architect|distributed|microservice|monolith|database|postgres|sqlite|mysql|kubernetes|scal(e|ing|ability)|infrastructure|consensus|架构|分布式|数据库|微服务|基础设施/i,
  ],
  [
    '初创',
    /startup|start-up|founder|bootstrapp|entrepreneur|product.market|saas|business|profitable|revenue|small team|创业|初创|创始人|商业|盈利|小团队/i,
  ],
  [
    '工程经验',
    /engineering|postmortem|post-mortem|incident|outage|debugging|migration|lessons|learned|production|retrospective|how we|performance|latency|maintain|reliability|复盘|工程|迁移|故障|调试|经验|性能|可靠性/i,
  ],
];

export function inferTopics(text: string): string[] {
  return topicPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export class ReadingCatalog {
  constructor(
    private readonly store: ReadingStore,
    private readonly publications: PublicationRepository,
  ) {}

  async refresh(): Promise<void> {
    for (const publication of this.publications.listPublications()) {
      if (publication.state !== 'published' || !publication.page) continue;
      const { story, summary, article } = publication.draft;
      if ((story.score ?? 0) < 150 || article.source === 'unavailable') continue;
      const existing = this.store.article(story.id);
      if (existing?.summaryUrl === publication.page.url) continue;
      const tags = isScanCardSummary(summary) ? summary.tags : [];
      const readingArticle: ReadingArticle = {
        id: story.id,
        title: summary.title,
        originalTitle: (story.title ?? summary.title).slice(0, 300),
        url:
          story.url && /^https?:\/\//i.test(story.url)
            ? story.url
            : `https://news.ycombinator.com/item?id=${story.id}`,
        summaryUrl: publication.page.url,
        description: (isScanCardSummary(summary) ? summary.quickTake : summary.introduction).slice(
          0,
          250,
        ),
        topics: [
          ...new Set([
            ...inferTopics(`${story.title} ${summary.title} ${summary.introduction}`),
            ...tags,
          ]),
        ].slice(0, 8),
        score: story.score ?? 0,
        time: story.time,
        minutes: article.readingMinutes,
        evidence: 'summary',
        sourceCharacters: article.text.length,
        truncated: article.text.length >= 45000,
      };
      this.store.saveArticle(readingArticle);
      this.store.saveSource(story.id, article);
    }
  }
}

export function articleFromCandidate(candidate: Candidate, source: Article): ReadingArticle {
  return {
    id: candidate.id,
    title: candidate.title.slice(0, 180),
    originalTitle: candidate.title.slice(0, 300),
    url: candidate.url,
    summaryUrl: null,
    description: '',
    topics: candidate.topics,
    score: candidate.score,
    time: candidate.time,
    minutes: source.readingMinutes,
    evidence: 'fulltext',
    sourceCharacters: source.text.length,
    truncated: source.text.length >= 45000,
  };
}
