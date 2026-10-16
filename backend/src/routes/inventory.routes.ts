import { Router } from 'express';
import * as inventory from '../controllers/inventory.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);

// Catalog
router.get('/product-types', requirePermission('inventory:read'), inventory.productTypes);
router.get('/products', requirePermission('inventory:read'), inventory.listProducts);
router.post('/products', requirePermission('inventory:operate'), inventory.createProduct);
router.get('/products/:id', requirePermission('inventory:read'), inventory.getProduct);
router.patch('/products/:id', requirePermission('inventory:operate'), inventory.updateProduct);

// Stock counted by quantity
router.post('/products/:id/receipts', requirePermission('inventory:operate'), inventory.receive);
router.post('/products/:id/reservations', requirePermission('inventory:operate'), inventory.reserve);
router.post('/products/:id/reservations/:reservationId/cancel', requirePermission('inventory:operate'), inventory.cancelReservation);
router.post('/products/:id/issues', requirePermission('inventory:operate'), inventory.issueUnits);
router.post('/products/:id/returns', requirePermission('inventory:operate'), inventory.returnUnits);
router.post('/products/:id/adjustments', requirePermission('inventory:adjust'), inventory.adjust);
router.post('/products/:id/discards', requirePermission('inventory:adjust'), inventory.discardUnits);
router.post('/products/:id/reversals', requirePermission('inventory:adjust'), inventory.reverse);

// Assets tracked one by one. /mine is open to everyone: only the person's own equipment.
router.get('/assets/mine', inventory.myAssets);
router.get('/assets', requirePermission('inventory:read'), inventory.listAssets);
router.post('/assets', requirePermission('inventory:operate'), inventory.registerAsset);
router.get('/assets/:id', requirePermission('inventory:read'), inventory.getAsset);
router.post('/assets/:id/:action', requirePermission('inventory:operate'), inventory.changeAsset);

// Management
router.get('/insights', requirePermission('inventory:insights'), inventory.insights);

// Ledger
router.get('/movements', requirePermission('inventory:read'), inventory.movements);
router.get('/movements/:id', requirePermission('inventory:read'), inventory.movement);

export default router;
