import { Router } from 'express';
import {
  assignTicket,
  changeStatus,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
} from '../controllers/ticket.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

// Ownership checks (requester vs IT) happen in the service, per ticket.
router.post('/', createTicket);
router.get('/', listTickets);
router.get('/:id', getTicket);
router.patch('/:id', updateTicket);

// Workflow actions: only roles with the "tickets:operate" permission.
router.patch('/:id/status', requirePermission('tickets:operate'), changeStatus);
router.patch('/:id/assignee', requirePermission('tickets:operate'), assignTicket);

export default router;
