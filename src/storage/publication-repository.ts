import type { FailureRecord, Publication } from '../domain.js';

export interface PublicationRepository {
  close(): void;
  getPublication(id: number): Publication | null;
  listPublications(): Publication[];
  savePublication(publication: Publication): void;
  recordFailure(id: number, code: string, now: number): void;
  retryAllowed(id: number, now: number): boolean;
  clearFailure(id: number): void;
  listFailures(): FailureRecord[];
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  acquireLease(owner: string, now: number, durationMs: number): boolean;
  renewLease(owner: string, now: number, durationMs: number): void;
  releaseLease(owner: string): void;
}
