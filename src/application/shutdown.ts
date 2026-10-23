import { setTimeout as delay } from 'node:timers/promises';

export async function drainPublishing(
  service: { readonly isRunning: boolean },
  closeReading: () => void,
  closePublications: () => void,
  timeoutMs = 170_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (service.isRunning && Date.now() < deadline) await delay(100);
  const drained = !service.isRunning;
  if (drained) {
    closeReading();
    closePublications();
  }
  return drained;
}
