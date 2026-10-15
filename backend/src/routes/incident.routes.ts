import { Router } from 'express';
import {
  close,
  follow,
  getParticipation,
  getPublic,
  indicators,
  listActive,
  listFollowed,
  listManaged,
  republish,
  unfollow,
  updatePublicText,
} from '../controllers/incident.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

// Team routes first, so "/manage" is not read as an incident id.
router.get('/manage', requirePermission('incidents:manage'), listManaged);
router.get('/indicators', requirePermission('incidents:manage'), indicators);
router.patch('/:id', requirePermission('incidents:manage'), updatePublicText);
router.post('/:id/close', requirePermission('incidents:manage'), close);
router.post('/:id/republish', requirePermission('incidents:manage'), republish);

// Public routes: active incidents and the authenticated user's own participation.
router.get('/', requirePermission('incidents:follow'), listActive);
router.get('/following', requirePermission('incidents:follow'), listFollowed);
router.get('/:id', requirePermission('incidents:follow'), getPublic);
router.get('/:id/participation', requirePermission('incidents:follow'), getParticipation);
router.put('/:id/participation', requirePermission('incidents:follow'), follow);
router.delete('/:id/participation', requirePermission('incidents:follow'), unfollow);

export default router;
