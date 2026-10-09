import type { QueryFilter, Types } from 'mongoose';
import { HttpError } from '../errors/http-error';
import {
  TicketModel,
  type Ticket,
  type TicketCategory,
  type TicketDocument,
  type TicketEventType,
  type TicketPriority,
  type TicketStatus,
} from '../models/ticket.model';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.model';

// ---------- Response shapes ----------

export interface TicketEventView {
  type: TicketEventType;
  message: string;
  at: Date;
  /** null when the author was deleted. */
  author: PublicUser | null;
}

export interface TicketSummary {
  id: string;
  title: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  requester: PublicUser | null;
  assignee: PublicUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  history: TicketEventView[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------- Inputs (already validated by the controller) ----------

export interface CreateTicketInput {
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
}

export interface ListTicketsQuery {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  search?: string;
  page: number;
  limit: number;
}

// ---------- Helpers ----------

type UserMap = Map<string, PublicUser>;

/** Loads every referenced user in a single query (avoids one query per ticket/event). */
async function loadUsers(ids: (Types.ObjectId | null)[]): Promise<UserMap> {
  const uniqueIds = [...new Set(ids.filter((id) => id !== null).map((id) => id.toString()))];
  const users = await UserModel.find({ _id: { $in: uniqueIds } });
  return new Map(users.map((user) => [user.id, toPublicUser(user)]));
}

function userFrom(users: UserMap, id: Types.ObjectId | null): PublicUser | null {
  return id ? (users.get(id.toString()) ?? null) : null;
}

function toSummary(ticket: TicketDocument, users: UserMap): TicketSummary {
  return {
    id: ticket.id,
    title: ticket.title,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    requester: userFrom(users, ticket.requester),
    assignee: userFrom(users, ticket.assignee),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export async function toTicketDetail(ticket: TicketDocument): Promise<TicketDetail> {
  const users = await loadUsers([
    ticket.requester,
    ticket.assignee,
    ...ticket.history.map((event) => event.author),
  ]);

  return {
    ...toSummary(ticket, users),
    description: ticket.description,
    history: ticket.history.map((event) => ({
      type: event.type,
      message: event.message,
      at: event.at,
      author: userFrom(users, event.author),
    })),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Access rules ----------

export function isRequester(ticket: TicketDocument, actor: PublicUser): boolean {
  return ticket.requester.equals(actor.id);
}

/**
 * IT sees every ticket; anyone else only their own. Other people's tickets
 * answer 404 (not 403) so the API does not reveal that they exist.
 */
export async function findAccessibleTicket(id: string, actor: PublicUser): Promise<TicketDocument> {
  const ticket = await TicketModel.findById(id);

  if (!ticket || (actor.role !== 'ti' && !isRequester(ticket, actor))) {
    throw new HttpError(404, 'Ticket not found');
  }

  return ticket;
}

// ---------- Use cases ----------

export async function createTicket(input: CreateTicketInput, actor: PublicUser): Promise<TicketDetail> {
  // The requester always comes from the authenticated user, never from the request body.
  const ticket = await TicketModel.create({
    ...input,
    requester: actor.id,
    history: [{ type: 'created', author: actor.id, message: 'Chamado aberto' }],
  });

  return toTicketDetail(ticket);
}

export async function listTickets(
  query: ListTicketsQuery,
  actor: PublicUser,
): Promise<{ tickets: TicketSummary[]; pagination: Pagination }> {
  const filter: QueryFilter<Ticket> = {};

  if (actor.role !== 'ti') filter.requester = actor.id;
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;
  if (query.category) filter.category = query.category;
  // User input is escaped so it is matched literally, not as a regular expression.
  if (query.search) filter.title = { $regex: escapeRegex(query.search), $options: 'i' };

  const { page, limit } = query;

  const [total, tickets] = await Promise.all([
    TicketModel.countDocuments(filter),
    TicketModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-description -history'),
  ]);

  const users = await loadUsers(tickets.flatMap((ticket) => [ticket.requester, ticket.assignee]));

  return {
    tickets: tickets.map((ticket) => toSummary(ticket, users)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTicket(id: string, actor: PublicUser): Promise<TicketDetail> {
  return toTicketDetail(await findAccessibleTicket(id, actor));
}
