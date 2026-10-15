import { Router } from 'express';
import {
  assignTicket,
  changeStatus,
  confirmResolution,
  contestResolution,
  createTicket,
  getIntakeQuestions,
  getTicket,
  listTickets,
  rateResolution,
  updateTicket,
} from '../controllers/ticket.controller';
import { getForTicket, publish as publishIncident } from '../controllers/incident.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

// Ownership checks (requester vs IT) happen in the service, per ticket.
router.post('/', createTicket);
router.get('/', listTickets);
router.get('/intake-questions', getIntakeQuestions);
router.get('/:id', getTicket);
router.patch('/:id', updateTicket);

// The requester's answer to a resolution: ownership is checked in the service (no status permission).
router.post('/:id/resolution/confirm', confirmResolution);
router.post('/:id/resolution/contest', contestResolution);
router.post('/:id/resolution/rating', rateResolution);

// Workflow actions: only roles with the "tickets:operate" permission.
router.patch('/:id/status', requirePermission('tickets:operate'), changeStatus);
router.patch('/:id/assignee', requirePermission('tickets:operate'), assignTicket);

// Shared incident published from this ticket (team only).
router.get('/:id/incident', requirePermission('incidents:manage'), getForTicket);
router.post('/:id/incident', requirePermission('incidents:manage'), publishIncident);

export default router;
