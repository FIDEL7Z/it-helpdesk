import { Router } from 'express';
import { login, me } from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { loginRateLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// Only the login is rate limited; other endpoints are not affected.
router.post('/login', loginRateLimiter, login);
router.get('/me', requireAuth, me);

export default router;
