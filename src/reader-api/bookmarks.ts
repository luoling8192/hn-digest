import { syncPublishedArticle } from '../recommendations/catalog.js';
import { newReader } from '../recommendations/model.js';
import { feedbackFor } from '../recommendations/ranking.js';
import type { ReadingStore } from '../recommendations/store.js';
import type { Publication } from '../domain.js';

export interface Bookmark {
  articleId: number;
  savedAt: number;
}

// Same state the bot's /saved list and the channel save button use: reader.feedback[id].saved.
export function listBookmarks(store: ReadingStore, userId: number): Bookmark[] {
  const reader = store.reader(userId);
  if (!reader) return [];
  return Object.entries(reader.feedback)
    .filter(([, feedback]) => feedback.saved)
    .map(([id, feedback]) => ({ articleId: Number(id), savedAt: feedback.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt || b.articleId - a.articleId);
}

/** Idempotently sets saved state. saveReader marks channel count sync pending on change. */
export function setBookmark(
  store: ReadingStore,
  userId: number,
  publication: Publication,
  saved: boolean,
  now: number,
): void {
  store.transaction(() => {
    const reader = store.reader(userId) ?? newReader(userId);
    const before = feedbackFor(reader, publication.id);
    if (before.saved === saved) return;
    const feedback = { ...before, saved, revision: before.revision + 1 };
    if (saved) feedback.savedAt = now;
    reader.feedback[publication.id] = feedback;
    syncPublishedArticle(store, publication);
    store.saveReader(reader);
  });
}
