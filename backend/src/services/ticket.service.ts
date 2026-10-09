import { Types, type QueryFilter } from 'mongoose';
import { HttpError } from '../errors/http-error';
import {
  STATUS_TRANSITIONS,
  TicketModel,
  type Ticket,
  type TicketCategory,
  type TicketDocument,
  type TicketEventType,
  type TicketPriority,
  type TicketStatus,
} from '../models/ticket.model';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.model';

// Labels used in history messages, which are shown to users in Portuguese.
const STATUS_LABELS: Record<TicketStatus, string> = {
  aberto: 'Aberto',
  em_andamento: 'Em andamento',
  resolvido: 'Resolvido',
};
const PRIORITY_LABELS: Record<TicketPriority, string> = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };
const CATEGORY_LABELS: Record<TicketCategory, string> = {
  hardware: 'Hardware',
  software: 'Software',
  rede: 'Rede',
  acesso: 'Acesso',
  outros: 'Outros',
};

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

// ---------- Updates ----------

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  category?: TicketCategory;
  priority?: TicketPriority;
}

type TicketChanges = Partial<
  Pick<Ticket, 'title' | 'description' | 'category' | 'priority' | 'status' | 'assignee'>
>;

interface NewEvent {
  type: TicketEventType;
  message: string;
}

/**
 * Applies the changes and appends history events in one atomic update.
 * The filter on updatedAt is an optimistic lock: if someone changed the ticket
 * after we read it, nothing is written and the client gets 409.
 */
async function saveChanges(
  ticket: TicketDocument,
  changes: TicketChanges,
  events: NewEvent[],
  actor: PublicUser,
): Promise<TicketDetail> {
  const at = new Date();
  const updated = await TicketModel.findOneAndUpdate(
    { _id: ticket._id, updatedAt: ticket.updatedAt },
    {
      $set: changes,
      $push: { history: { $each: events.map((event) => ({ ...event, author: actor.id, at })) } },
    },
    { returnDocument: 'after', runValidators: true },
  );

  if (!updated) {
    throw new HttpError(409, 'Ticket was changed by someone else. Reload and try again');
  }

  return toTicketDetail(updated);
}

/**
 * - Title and description: only the requester, and only while the ticket is open.
 * - Category and priority (triage): only IT, while the ticket is not resolved.
 * Status and assignee have their own endpoints.
 */
export async function updateTicket(
  id: string,
  input: UpdateTicketInput,
  actor: PublicUser,
): Promise<TicketDetail> {
  const ticket = await findAccessibleTicket(id, actor);

  if (input.title !== undefined || input.description !== undefined) {
    if (!isRequester(ticket, actor)) {
      throw new HttpError(403, 'Only the requester can edit the title and description');
    }
    if (ticket.status !== 'aberto') {
      throw new HttpError(409, 'Title and description can only be edited while the ticket is open');
    }
  }

  if (input.category !== undefined || input.priority !== undefined) {
    if (actor.role !== 'ti') {
      throw new HttpError(403, 'Only the IT team can change category and priority');
    }
    if (ticket.status === 'resolvido') {
      throw new HttpError(409, 'Resolved tickets cannot be changed');
    }
  }

  const changes: TicketChanges = {};
  const messages: string[] = [];

  if (input.title !== undefined && input.title !== ticket.title) {
    changes.title = input.title;
    messages.push('Título atualizado');
  }
  if (input.description !== undefined && input.description !== ticket.description) {
    changes.description = input.description;
    messages.push('Descrição atualizada');
  }
  if (input.category !== undefined && input.category !== ticket.category) {
    changes.category = input.category;
    messages.push(
      `Categoria alterada de ${CATEGORY_LABELS[ticket.category]} para ${CATEGORY_LABELS[input.category]}`,
    );
  }
  if (input.priority !== undefined && input.priority !== ticket.priority) {
    changes.priority = input.priority;
    messages.push(
      `Prioridade alterada de ${PRIORITY_LABELS[ticket.priority]} para ${PRIORITY_LABELS[input.priority]}`,
    );
  }

  // Same values as before: nothing to save, no history event.
  if (messages.length === 0) return toTicketDetail(ticket);

  return saveChanges(ticket, changes, [{ type: 'updated', message: messages.join('; ') }], actor);
}

/** IT only (enforced by the route). Follows STATUS_TRANSITIONS. */
export async function changeStatus(
  id: string,
  status: TicketStatus,
  actor: PublicUser,
): Promise<TicketDetail> {
  const ticket = await findAccessibleTicket(id, actor);
  const from = ticket.status;

  if (!STATUS_TRANSITIONS[from].includes(status)) {
    throw new HttpError(409, `Cannot change status from ${from} to ${status}`);
  }

  const reopening = from === 'resolvido';
  const changes: TicketChanges = { status };
  const events: NewEvent[] = [
    {
      type: reopening ? 'reopened' : 'status_changed',
      message: reopening
        ? `Chamado reaberto (${STATUS_LABELS[from]} → ${STATUS_LABELS[status]})`
        : `Status alterado de ${STATUS_LABELS[from]} para ${STATUS_LABELS[status]}`,
    },
  ];

  // Starting work on an unassigned ticket makes the person who started it the assignee.
  if (status === 'em_andamento' && !ticket.assignee) {
    changes.assignee = new Types.ObjectId(actor.id);
    events.push({ type: 'assigned', message: `Responsável definido: ${actor.name}` });
  }

  return saveChanges(ticket, changes, events, actor);
}

/** IT only (enforced by the route). The assignee must be an IT user. */
export async function assignTicket(
  id: string,
  assigneeId: string,
  actor: PublicUser,
): Promise<TicketDetail> {
  const ticket = await findAccessibleTicket(id, actor);

  if (ticket.status === 'resolvido') {
    throw new HttpError(409, 'Resolved tickets cannot be reassigned');
  }

  const assignee = await UserModel.findById(assigneeId);
  if (!assignee || assignee.role !== 'ti') {
    throw new HttpError(400, 'Assignee must be an IT team member');
  }

  if (ticket.assignee?.equals(assignee._id)) return toTicketDetail(ticket);

  const previous = ticket.assignee ? await UserModel.findById(ticket.assignee) : null;
  const message = previous
    ? `Responsável alterado de ${previous.name} para ${assignee.name}`
    : `Responsável definido: ${assignee.name}`;

  return saveChanges(ticket, { assignee: assignee._id }, [{ type: 'assigned', message }], actor);
}
