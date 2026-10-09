import { Router } from 'express';
import { listItStaff } from '../controllers/user.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.get('/it-staff', requireAuth, requireRole('ti'), listItStaff);

export default router;
