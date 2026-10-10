import { Router } from 'express';
import { listItStaff } from '../controllers/user.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.get('/it-staff', requireAuth, requirePermission('users:list-it-staff'), listItStaff);

export default router;
