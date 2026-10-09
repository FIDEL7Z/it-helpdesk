import type { PipelineStage } from 'mongoose';
import { can } from '../auth/permissions';
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketModel,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '../models/ticket.model';
import type { PublicUser } from '../models/user.model';
import { buildTicketFilter, listTickets, type TicketSummary } from './ticket.service';

export const RECENT_TICKETS_LIMIT = 5;

/** Tickets that still need work. */
const PENDING_STATUSES: TicketStatus[] = ['aberto', 'em_andamento'];

export interface DashboardSummary {
  /** "all" when the user can see every ticket, "mine" otherwise (only their own tickets are counted). */
  scope: 'all' | 'mine';
  byStatus: Record<TicketStatus, number> & { total: number };
  pendingByPriority: Record<TicketPriority, number>;
  pendingByCategory: Record<TicketCategory, number>;
  /** Only for users who operate tickets. Each number matches the ticket list with the same filters. */
  workload?: {
    /** = GET /tickets?assignee=none */
    unassigned: number;
    /** = GET /tickets?assignee=me&status=em_andamento */
    inProgressAssignedToMe: number;
  };
  /** Same order as the ticket list (newest first). */
  recent: TicketSummary[];
}

type CountRow<K> = { _id: K; count: number };

interface FacetResult {
  byStatus: CountRow<TicketStatus>[];
  pendingByPriority: CountRow<TicketPriority>[];
  pendingByCategory: CountRow<TicketCategory>[];
  unassigned?: { count: number }[];
  inProgressAssignedToMe?: { count: number }[];
}

/** MongoDB only returns groups that exist; fill the missing keys with 0. */
function countBy<K extends string>(keys: readonly K[], rows: CountRow<K>[]): Record<K, number> {
  // Every key is set right below, so the object matches the declared type.
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

function countOf(rows: { count: number }[] | undefined): number {
  return rows?.[0]?.count ?? 0;
}

export async function getDashboardSummary(actor: PublicUser): Promise<DashboardSummary> {
  const seesAllTickets = can(actor.role, 'tickets:view-all');
  // The personal workload only makes sense for people who work on tickets.
  const hasWorkload = can(actor.role, 'tickets:operate');

  // Each facet is an independent pipeline that runs over the documents that
  // passed the first $match (the user's scope), all in one database query.
  const facets: PipelineStage.Facet['$facet'] = {
    byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
    pendingByPriority: [
      { $match: { status: { $in: PENDING_STATUSES } } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ],
    pendingByCategory: [
      { $match: { status: { $in: PENDING_STATUSES } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ],
  };

  if (hasWorkload) {
    // Same filter builder as the list endpoint, so the card and the list agree.
    facets.unassigned = [{ $match: buildTicketFilter({ assignee: 'none' }, actor) }, { $count: 'count' }];
    facets.inProgressAssignedToMe = [
      { $match: buildTicketFilter({ assignee: 'me', status: 'em_andamento' }, actor) },
      { $count: 'count' },
    ];
  }

  const [[result], recent] = await Promise.all([
    TicketModel.aggregate<FacetResult>([
      // Authorization first: requesters only ever aggregate their own tickets.
      { $match: buildTicketFilter({}, actor) },
      { $facet: facets },
    ]),
    listTickets({ page: 1, limit: RECENT_TICKETS_LIMIT }, actor),
  ]);

  const byStatus = countBy(TICKET_STATUSES, result.byStatus);

  return {
    scope: seesAllTickets ? 'all' : 'mine',
    byStatus: { ...byStatus, total: byStatus.aberto + byStatus.em_andamento + byStatus.resolvido },
    pendingByPriority: countBy(TICKET_PRIORITIES, result.pendingByPriority),
    pendingByCategory: countBy(TICKET_CATEGORIES, result.pendingByCategory),
    ...(hasWorkload && {
      workload: {
        unassigned: countOf(result.unassigned),
        inProgressAssignedToMe: countOf(result.inProgressAssignedToMe),
      },
    }),
    recent: recent.tickets,
  };
}
