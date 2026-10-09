import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must have at least 32 characters'),
  // Accepts values like "15m", "8h" or "1d" (the format jsonwebtoken expects).
  JWT_EXPIRES_IN: z
    .templateLiteral([z.number().int().positive(), z.enum(['s', 'm', 'h', 'd'])])
    .default('8h'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
