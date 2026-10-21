import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { ask } from '../services/assistant/assistant.service';

// The question and, to continue a conversation, its id. Who asks comes from the token; what may be
// read is decided in the backend; the conversation history stays in the backend.
const askSchema = z.strictObject({
  question: z.string().trim().min(1).max(1000),
  conversationId: z.uuid().optional(),
});

export async function askAssistant(req: Request, res: Response): Promise<void> {
  const { question, conversationId } = askSchema.parse(req.body);
  res.json({ reply: await ask(getAuthenticatedUser(req), question, conversationId) });
}
