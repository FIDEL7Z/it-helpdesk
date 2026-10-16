import { can } from '../auth/permissions';
import { AssetModel, ProductModel, StockMovementModel } from '../models/inventory.model';
import type { PublicUser } from '../models/user.model';
import { assetViews, type AssetView } from './asset.service';
import { movementViews, type MovementView } from './movement.service';
import { toLocationView, type LocationView } from './organization.service';
import { openReservations } from './stock.service';
import { findAccessibleTicket } from './ticket.service';

/**
 * Materials of a ticket. Deliveries are stock movements that point to the ticket; they never change
 * the ticket status, and resolving a ticket never moves stock.
 */
export interface TeamTicketMaterials {
  view: 'team';
  movements: MovementView[];
  openReservations: MovementView[];
  reservedAssets: AssetView[];
}

/** What the requester sees: what was delivered for their request, nothing about the store room. */
export interface RequesterDelivery {
  id: string;
  product: { name: string; type: string };
  quantity: number;
  deliveredAt: Date;
  deliveredBy: { name: string };
  /** True when the requester was the one who received it. */
  receivedByYou: boolean;
  /** Only for equipment they received: its asset tag. */
  assetTag: string | null;
  location: LocationView | null;
}

export interface RequesterTicketMaterials {
  view: 'requester';
  deliveries: RequesterDelivery[];
}

export async function ticketMaterials(ticketId: string, actor: PublicUser): Promise<TeamTicketMaterials | RequesterTicketMaterials> {
  // Same access rule as the ticket: someone else's ticket is 404 for a requester.
  const ticket = await findAccessibleTicket(ticketId, actor);
  const movements = await StockMovementModel.find({ ticket: ticket._id }).sort({ occurredAt: 1, _id: 1 });

  if (can(actor.role, 'inventory:read')) {
    const [views, reservations, reserved] = await Promise.all([
      movementViews(movements),
      openReservations({ ticket: ticket._id }).then(movementViews),
      AssetModel.find({ ticket: ticket._id, status: 'reserved' }).then(assetViews),
    ]);
    return { view: 'team', movements: views, openReservations: reservations, reservedAssets: reserved };
  }

  const reversed = new Set(movements.filter((m) => m.reverses).map((m) => m.reverses!.toString()));
  const delivered = movements.filter((m) => (m.type === 'issue' || m.type === 'asset_assign') && !reversed.has(m.id));
  const [products, assets] = await Promise.all([
    ProductModel.find({ _id: { $in: delivered.map((m) => m.product) } }).select('name type'),
    AssetModel.find({ _id: { $in: delivered.map((m) => m.asset).filter(Boolean) } }).select('assetTag'),
  ]);
  return {
    view: 'requester',
    deliveries: delivered.map((m) => {
      const product = products.find((p) => p._id.equals(m.product));
      const mine = m.recipient?.id.equals(actor.id) ?? false;
      return {
        id: m.id,
        product: { name: product?.name ?? 'Material', type: product?.type ?? 'outro' },
        quantity: m.quantity,
        deliveredAt: m.occurredAt,
        deliveredBy: { name: m.actorSnapshot.name },
        receivedByYou: mine,
        assetTag: mine && m.asset ? assets.find((a) => a._id.equals(m.asset!))?.assetTag ?? null : null,
        location: toLocationView(m.location),
      };
    }),
  };
}
