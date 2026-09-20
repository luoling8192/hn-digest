import { emptyFeedback, type ReadingArticle, type Reader } from './model.js';

const normalized = (topic: string) => topic.toLocaleLowerCase().trim();

export function topicWeights(reader: Reader, articles: ReadingArticle[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const interest of reader.interests)
    weights.set(normalized(interest.name), interest.weight * 3);
  for (const article of articles) {
    const feedback = reader.feedback[article.id];
    if (!feedback) continue;
    const signal = (feedback.saved ? 1 : 0) + feedback.opinion * 3;
    for (const topic of article.topics) {
      const key = normalized(topic);
      weights.set(key, (weights.get(key) ?? 0) + signal / Math.max(1, article.topics.length));
    }
  }
  return weights;
}

export function recommend(
  reader: Reader,
  articles: ReadingArticle[],
): { article: ReadingArticle; reason: string }[] {
  const weights = topicWeights(reader, articles);
  const seen = new Set(reader.seen);
  const pool = articles.filter(
    (article) =>
      article.evidence !== 'title' &&
      article.score >= 150 &&
      !seen.has(article.id) &&
      !reader.feedback[article.id]?.saved &&
      (reader.feedback[article.id]?.opinion ?? 0) >= 0,
  );
  const chosen: { article: ReadingArticle; reason: string }[] = [];
  const usedTopics = new Map<string, number>();
  while (chosen.length < 5 && pool.length) {
    const scored = pool
      .map((article) => {
        const topics = article.topics.map(normalized);
        const searchable = normalized(
          `${article.originalTitle} ${article.title} ${article.description} ${article.topics.join(' ')}`,
        );
        const textualAffinity = reader.interests.reduce((sum, interest) => {
          if (topics.includes(normalized(interest.name))) return sum;
          const terms = [
            interest.name,
            ...interest.query.split(/\s+/).filter((term) => term.length > 3),
          ];
          return (
            sum +
            (terms.some((term) => searchable.includes(normalized(term))) ? interest.weight * 2 : 0)
          );
        }, 0);
        const affinity =
          topics.reduce((sum, topic) => sum + (weights.get(topic) ?? 0), 0) + textualAffinity;
        const diversity = topics.reduce((sum, topic) => sum + (usedTopics.get(topic) ?? 0) * 2, 0);
        return { article, value: affinity + Math.log2(1 + article.score) * 0.5 - diversity };
      })
      .sort(
        (a, b) =>
          b.value - a.value || b.article.score - a.article.score || b.article.id - a.article.id,
      );
    const best = scored[0];
    if (!best) break;
    const matching = best.article.topics
      .filter((topic) => (weights.get(normalized(topic)) ?? 0) > 0)
      .slice(0, 2);
    chosen.push({
      article: best.article,
      reason: matching.length ? `与你的兴趣相关：${matching.join('、')}` : '探索推荐 · HN 高分文章',
    });
    for (const topic of best.article.topics)
      usedTopics.set(normalized(topic), (usedTopics.get(normalized(topic)) ?? 0) + 1);
    pool.splice(
      pool.findIndex((article) => article.id === best.article.id),
      1,
    );
  }
  return chosen;
}

export function feedbackFor(reader: Reader, id: number) {
  return reader.feedback[id] ?? emptyFeedback();
}
