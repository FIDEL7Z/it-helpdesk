import { Router } from 'express';
import { createArticle, getArticle, giveFeedback, search, searchManaged, updateArticle } from '../controllers/article.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

// Team routes first, so "/manage" is not read as an article id.
router.get('/manage', requirePermission('kb:manage'), searchManaged);
router.post('/', requirePermission('kb:manage'), createArticle);
router.patch('/:id', requirePermission('kb:manage'), updateArticle);

// Readers: published articles only (drafts answer 404 to people without kb:manage).
router.get('/', requirePermission('kb:read'), search);
router.get('/:id', requirePermission('kb:read'), getArticle);
router.put('/:id/feedback', requirePermission('kb:read'), giveFeedback);

export default router;
