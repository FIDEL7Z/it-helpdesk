import { MemoryStore, rateLimit } from 'express-rate-limit';

/** 10 login attempts per IP every 15 minutes (successful or not). */
export const LOGIN_RATE_LIMIT = {
  limit: 10,
  windowMs: 15 * 60 * 1000,
} as const;

// Counters live in this process's memory: they reset when the server restarts and are
// not shared between instances. Enough for a single-instance internal app.
const loginAttemptsStore = new MemoryStore();

/** Slows down password guessing on POST /api/auth/login. Answers 429 when exceeded. */
export const loginRateLimiter = rateLimit({
  ...LOGIN_RATE_LIMIT,
  store: loginAttemptsStore,
  // Sends the standard RateLimit / RateLimit-Policy / Retry-After headers.
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again later' },
});

/** Clears every counter. Used by the tests, which log in many times from the same IP. */
export function resetLoginRateLimit(): Promise<void> {
  return loginAttemptsStore.resetAll();
}

/** Confirmation links: 20 tries per IP every 15 minutes, against token guessing (tokens have 256 bits). */
export const emailConfirmationRateLimiter = rateLimit({
  limit: 20,
  windowMs: 15 * 60 * 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many confirmation attempts. Try again later' },
});

/**
 * Assistant questions: 20 per person every 10 minutes (after requireAuth, keyed by the user, so
 * people behind one IP do not share it). Protects the answer service quota from one session.
 */
export const assistantRateLimiter = rateLimit({
  limit: 20,
  windowMs: 10 * 60 * 1000,
  keyGenerator: (req) => `assistant:${req.user?.id ?? 'anonymous'}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many questions. Try again in a few minutes', code: 'ASSISTANT_RATE_LIMITED' },
});
