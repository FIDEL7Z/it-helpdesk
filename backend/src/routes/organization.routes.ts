import { Router } from 'express';
import { createDepartment, createRoom, list, listPeople, setPersonLocation, updateDepartment, updateRoom } from '../controllers/organization.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', requirePermission('org:read'), list);
router.post('/departments', requirePermission('org:manage'), createDepartment);
router.patch('/departments/:id', requirePermission('org:manage'), updateDepartment);
router.post('/rooms', requirePermission('org:manage'), createRoom);
router.patch('/rooms/:id', requirePermission('org:manage'), updateRoom);
router.get('/people', requirePermission('people:list'), listPeople);
router.patch('/people/:id', requirePermission('org:manage'), setPersonLocation);

export default router;
