import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { ask } from '../services/assistant/assistant.service';

// The question only. Who asks comes from the token; what may be read is decided in the backend.
const question = z.strictObject({ question: z.string().trim().min(3).max(500) });

export async function askAssistant(req: Request, res: Response): Promise<void> {
  res.json({ reply: await ask(getAuthenticatedUser(req), question.parse(req.body).question) });
}
