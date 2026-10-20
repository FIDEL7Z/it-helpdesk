import { Router } from 'express';
import { askAssistant } from '../controllers/assistant.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { assistantRateLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Any profile may ask; the answer only uses what that profile may already see.
router.post('/ask', requireAuth, assistantRateLimiter, askAssistant);

export default router;
