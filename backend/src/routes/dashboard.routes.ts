import { Router } from 'express';
import { getSummary, getManager } from '../controllers/dashboard.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.get('/summary', requireAuth, getSummary);
router.get('/manager', requireAuth, requireRole('gestor'), getManager);

export default router;
