import { z } from 'zod';

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_CHAT_ID: z.string().regex(/^-100\d+$/),
  OPENROUTER_API_KEY: z.string().min(20),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash'),
  TELEGRAPH_ACCESS_TOKEN: z.string().min(10),
  CHANNEL_NAME: z.string().max(128).default('Hacker News 摘要'),
  CHANNEL_URL: z.url().optional(),
  ADMIN_TOKEN: z.string().min(32),
  DATA_DIR: z.string().default('./data'),
  AUTO_PUBLISH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MIN_SCORE: positiveInteger(150),
  POLL_INTERVAL_SECONDS: positiveInteger(600),
  MAX_NEW_PER_CYCLE: positiveInteger(3),
  COMMENT_UPDATE_THRESHOLD: positiveInteger(10),
  MAX_COMMENT_UPDATES: positiveInteger(3),
  PORT: positiveInteger(3_000),
});

export type Config = z.infer<typeof configSchema>;

export function readConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(environment);
  if (result.success) return result.data;

  const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`Invalid configuration: ${fields}`);
}
