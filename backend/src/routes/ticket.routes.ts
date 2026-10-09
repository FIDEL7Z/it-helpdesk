import { Router } from 'express';
import { createTicket, getTicket, listTickets } from '../controllers/ticket.controller';
import { requireAuth } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

router.post('/', createTicket);
router.get('/', listTickets);
router.get('/:id', getTicket);

export default router;
