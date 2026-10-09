import { Router } from 'express';
import {
  assignTicket,
  changeStatus,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
} from '../controllers/ticket.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

// Ownership checks (requester vs IT) happen in the service, per ticket.
router.post('/', createTicket);
router.get('/', listTickets);
router.get('/:id', getTicket);
router.patch('/:id', updateTicket);

// Workflow actions are restricted to the IT team.
router.patch('/:id/status', requireRole('ti'), changeStatus);
router.patch('/:id/assignee', requireRole('ti'), assignTicket);

export default router;
