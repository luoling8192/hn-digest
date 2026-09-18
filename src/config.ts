import { z } from 'zod';

const positive = (value: number) => z.coerce.number().int().positive().default(value);
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
  AUTO_PUBLISH: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  MIN_SCORE: positive(150),
  POLL_INTERVAL_SECONDS: positive(600),
  MAX_NEW_PER_CYCLE: positive(3),
  COMMENT_UPDATE_THRESHOLD: positive(30),
  MAX_COMMENT_UPDATES: positive(3),
  PORT: positive(3000),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  return result.data;
}
