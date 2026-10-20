import { Router } from 'express';
import { cancelPendingEmail, changeEmail, confirmEmail, requestVerification, show, updatePreferences } from '../controllers/account.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { emailConfirmationRateLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// The link in the e-mail works without a session: the single-use token is the proof.
router.post('/email/confirm', emailConfirmationRateLimiter, confirmEmail);

// Everything else acts only on the authenticated user's own account.
router.use(requireAuth);
router.get('/', show);
router.patch('/notification-preferences', updatePreferences);
router.post('/email/verification', requestVerification);
router.put('/email', changeEmail);
router.delete('/email/pending', cancelPendingEmail);

export default router;
