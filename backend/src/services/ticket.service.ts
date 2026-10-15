import { randomUUID } from 'node:crypto';
import { daysAgo, lastOperationalActivity } from './activity';
import { Types, type QueryFilter } from 'mongoose';
import { can } from '../auth/permissions';
import { HttpError } from '../errors/http-error';
import {
  STATUS_TRANSITIONS,
  TicketModel,
  type AuditEvent,
  type Ticket,
  type TicketCategory,
  type TicketDocument,
  type TicketEventType,
  type TicketPriority,
  type TicketStatus,
} from '../models/ticket.model';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.model';
import { KnowledgeArticleModel } from '../models/article.model';
import { buildIntakeAnswers, type IntakeAnswerInput } from './intake';

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
  at: Date | null;
  authorId: string | null;
  audit?: AuditEvent;
  assigneeAtEvent: PublicUser | null;
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
  assigneeId: string | null;
  requesterId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  revision: number;
  activeCycleId: number;
  resolvedAt: Date | null;
  resolvedBy: PublicUser | null;
  resolvedById: string | null;
  dataOrigin: Ticket['dataOrigin'];
  /** The requester said the last resolution did not solve the problem (current cycle). */
  contested: boolean;
}

/** Guided-form answers as the team and the requester read them. */
export interface IntakeView {
  category: TicketCategory;
  answers: { key: string; question: string; answer: string }[];
  article: { id: string; title: string } | null;
}

/** The requester's answer to the resolution of the current cycle (or the one they contested). */
export interface ResolutionFeedbackView {
  cycleId: number;
  status: 'pending' | 'confirmed' | 'contested';
  rating: number | null;
  comment: string | null;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  intake: IntakeView | null;
  resolutionFeedback: ResolutionFeedbackView | null;
  history: TicketEventView[];
}

/**
 * What a requester receives about their own request: an explicit allowlist, not the team
 * shape with fields removed. No audit metadata, justifications, cycles, data origin or other
 * people's ids and contact data; people appear by name only.
 */
export interface PersonName {
  name: string;
}

export interface RequesterEventView {
  type: TicketEventType;
  message: string;
  at: Date | null;
  author: PersonName | null;
}

export interface RequesterTicketSummary {
  id: string;
  title: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  /** The requester's own id, so the client can tell it is their request. */
  requesterId: string | null;
  assignee: PersonName | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Needed to edit the text while the request is open. */
  revision: number;
  resolvedAt: Date | null;
  /** Resolved and the requester has not said yet whether it worked. */
  awaitingConfirmation: boolean;
}

export interface RequesterTicketDetail extends RequesterTicketSummary {
  description: string;
  /** Their own answers, as they gave them. */
  intake: IntakeView | null;
  resolutionFeedback: ResolutionFeedbackView | null;
  history: RequesterEventView[];
}

export type TicketSummaryView = TicketSummary | RequesterTicketSummary;
export type TicketDetailView = TicketDetail | RequesterTicketDetail;

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
  intake?: { answers: IntakeAnswerInput[]; articleId?: string };
}

export const ASSIGNEE_FILTERS = ['none', 'me'] as const;
export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number];

export interface TicketFilters {
  createdFrom?: string; createdTo?: string;
  /** contested: the requester said the last resolution did not work and the ticket is back in progress. */
  attention?: 'high_unassigned' | 'oldest' | 'inactive' | 'contested';
  inactivityDays?: number;
  ageDays?: number;
  pending?: boolean;
  assigneeId?: string;
  requesterId?: string;
  dataOrigin?: Ticket['dataOrigin'];
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  search?: string;
  /** "none": no assignee yet; "me": assigned to the authenticated user. */
  assignee?: AssigneeFilter;
  /** Creation order; oldest first helps pick the next ticket from a queue. */
  sort?: 'newest' | 'oldest';
}

export interface ListTicketsQuery extends TicketFilters {
  page: number;
  limit: number;
}

// ---------- Helpers ----------

type UserMap = Map<string, PublicUser>;

/** Loads every referenced user in a single query (avoids one query per ticket/event). */
async function loadUsers(ids: (Types.ObjectId | null | undefined)[]): Promise<UserMap> {
  const uniqueIds = [...new Set(ids.filter((id): id is Types.ObjectId => id != null).map((id) => id.toString()))];
  const users = await UserModel.find({ _id: { $in: uniqueIds } });
  return new Map(users.map((user) => [user.id, toPublicUser(user)]));
}

function userFrom(users: UserMap, id: Types.ObjectId | null | undefined): PublicUser | null {
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
    assigneeId: ticket.assignee?.toString() ?? null,
    requesterId: ticket.requester?.toString() ?? null,
    createdAt: ticket.createdAt ?? null,
    updatedAt: ticket.updatedAt ?? null,
    revision: ticket.revision ?? 0,
    activeCycleId: ticket.activeCycleId ?? 1,
    resolvedAt: ticket.resolvedAt ?? null,
    resolvedBy: userFrom(users, ticket.resolvedBy),
    resolvedById: ticket.resolvedBy?.toString() ?? null,
    dataOrigin: ticket.dataOrigin ?? 'legacy',
    contested: resolutionFeedbackOf(ticket)?.status === 'contested',
  };
}

function resolutionFeedbackOf(ticket: TicketDocument): ResolutionFeedbackView | null {
  const cycle = ticket.activeCycleId ?? 1;
  const inCycle = (type: TicketEventType) => ticket.history?.find((event) => event.type === type && event.audit?.cycleId === cycle);
  if (ticket.status === 'resolvido') {
    const rated = inCycle('resolution_rated')?.audit?.to;
    return {
      cycleId: cycle,
      status: inCycle('resolution_confirmed') ? 'confirmed' : 'pending',
      rating: typeof rated?.rating === 'number' ? rated.rating : null,
      comment: typeof rated?.comment === 'string' ? rated.comment : null,
    };
  }
  const contest = ticket.history?.find((event) => event.type === 'reopened' && event.audit?.cycleId === cycle
    && typeof event.audit.to?.contestedCycle === 'number');
  return contest ? { cycleId: contest.audit!.to.contestedCycle as number, status: 'contested', rating: null, comment: null } : null;
}

function toIntakeView(ticket: TicketDocument): IntakeView | null {
  if (!ticket.intake) return null;
  return {
    category: ticket.intake.category,
    answers: ticket.intake.answers.map(({ key, question, answer }) => ({ key, question, answer })),
    article: ticket.intake.article ? { id: ticket.intake.article.id.toString(), title: ticket.intake.article.title } : null,
  };
}

function nameOf(user: PublicUser | null): PersonName | null {
  return user ? { name: user.name } : null;
}

function toRequesterSummary(ticket: TicketDocument, users: UserMap): RequesterTicketSummary {
  return {
    id: ticket.id,
    title: ticket.title,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    requesterId: ticket.requester?.toString() ?? null,
    assignee: nameOf(userFrom(users, ticket.assignee)),
    createdAt: ticket.createdAt ?? null,
    updatedAt: ticket.updatedAt ?? null,
    revision: ticket.revision ?? 0,
    resolvedAt: ticket.resolvedAt ?? null,
    awaitingConfirmation: resolutionFeedbackOf(ticket)?.status === 'pending',
  };
}

/** Team shape for operators with tickets:view-audit; the requester allowlist for everyone else. */
function toSummaryFor(ticket: TicketDocument, users: UserMap, actor: PublicUser): TicketSummaryView {
  return can(actor.role, 'tickets:view-audit') ? toSummary(ticket, users) : toRequesterSummary(ticket, users);
}

export async function toTicketDetail(ticket: TicketDocument, actor: PublicUser): Promise<TicketDetailView> {
  const users = await loadUsers([
    ticket.requester,
    ticket.assignee,
    ticket.resolvedBy,
    ...ticket.history.flatMap(event => [event.audit?.assigneeAtEvent ?? null]),
    ...ticket.history.map((event) => event.author),
  ]);

  if (!can(actor.role, 'tickets:view-audit')) {
    return {
      ...toRequesterSummary(ticket, users),
      description: ticket.description,
      intake: toIntakeView(ticket),
      resolutionFeedback: resolutionFeedbackOf(ticket),
      history: ticket.history.map((event) => ({
        type: event.type,
        message: event.message,
        at: event.at ?? null,
        // The name recorded at the time of the action, when available.
        author: event.audit?.actorSnapshot ? { name: event.audit.actorSnapshot.name } : nameOf(userFrom(users, event.author)),
      })),
    };
  }

  return {
    ...toSummary(ticket, users),
    description: ticket.description,
    intake: toIntakeView(ticket),
    resolutionFeedback: resolutionFeedbackOf(ticket),
    history: ticket.history.map((event) => ({
      authorId: event.author?.toString() ?? null,
      audit: event.audit,
      assigneeAtEvent: userFrom(users, event.audit?.assigneeAtEvent ?? null),
      type: event.type,
      message: event.message,
      at: event.at ?? null,
      author: userFrom(users, event.author),
    })),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Demo identities are explicitly reserved seed accounts; other legacy data stays unknown.
const DEMO_EMAILS = new Set(['ti@helpdesk.local', 'solicitante@helpdesk.local', 'gestor@helpdesk.local', 'demo.ti2@helpdesk.local', 'demo.solicitante2@helpdesk.local']);
function ticketOrigin(ticket: TicketDocument, users: UserMap): Ticket['dataOrigin'] {
  if (ticket.dataOrigin !== 'legacy') return ticket.dataOrigin;
  return DEMO_EMAILS.has(userFrom(users, ticket.requester)?.email ?? '') || ticket.title.startsWith('[DEMO-EQUIPE]') ? 'demo' : 'legacy';
}
/** Snapshots preserve the identity at the action; the actor comes only from requireAuth. */
function auditEvent(actor: PublicUser, type: TicketEventType, at: Date, revision: number,
  cycleId: number, from: Record<string, unknown>, to: Record<string, unknown>,
  assignee: Types.ObjectId | null, origin: Ticket['dataOrigin'], operationId: string, eventIndex: number, reason?: string, responsible?: PublicUser | null): AuditEvent {
  return { eventId: randomUUID(), operationId, schemaVersion: 2, actorId: new Types.ObjectId(actor.id),
    actorSnapshot: { name: actor.name, role: actor.role }, eventType: type, occurredAt: at,
    revision, eventIndex, cycleId, from, to, assigneeAtEvent: assignee, dataOrigin: origin,
    assigneeSnapshot: responsible ? { id: responsible.id, name: responsible.name, role: responsible.role } : null,
    ...(reason ? { reason } : {}) };
}
function assertRevision(ticket: TicketDocument, expectedRevision: number): void {
  if ((ticket.revision ?? 0) !== expectedRevision) throw new HttpError(409, 'Ticket was changed by someone else. Reload and try again');
}

// ---------- Access rules ----------

export function isRequester(ticket: TicketDocument, actor: PublicUser): boolean {
  return ticket.requester.equals(actor.id);
}

/**
 * Operators with tickets:view-all (TI and manager) see every ticket; requesters see only their own. Other people's tickets
 * answer 404 (not 403) so the API does not reveal that they exist.
 */
export async function findAccessibleTicket(id: string, actor: PublicUser): Promise<TicketDocument> {
  const ticket = await TicketModel.findById(id);

  if (!ticket || (!can(actor.role, 'tickets:view-all') && !isRequester(ticket, actor))) {
    throw new HttpError(404, 'Ticket not found');
  }

  return ticket;
}

/**
 * Single place that turns filters into a MongoDB query, always scoped to what the
 * user may see (requesters: only their own tickets). Used by the ticket list and
 * by the dashboard, so their numbers always match.
 * Ids are ObjectIds (not strings) because aggregation pipelines do not cast types.
 */
export function buildTicketFilter(filters: TicketFilters, actor: PublicUser): QueryFilter<Ticket> {
  const actorId = new Types.ObjectId(actor.id);
  const filter: QueryFilter<Ticket> = {};

  if (!can(actor.role, 'tickets:view-all')) filter.requester = actorId;
  if (filters.requesterId) {
    if (!can(actor.role, 'tickets:view-all') && filters.requesterId.toLowerCase() !== actor.id) throw new HttpError(403, 'You do not have permission to access this resource');
    filter.requester = new Types.ObjectId(filters.requesterId);
  }
  if (filters.assigneeId) {
    if (!can(actor.role, 'tickets:view-all')) throw new HttpError(403, 'You do not have permission to access this resource');
    filter.assignee = new Types.ObjectId(filters.assigneeId);
  }
  if (filters.dataOrigin === 'legacy') filter.$or = [{ dataOrigin: 'legacy' }, { dataOrigin: { $exists: false } }];
  else if (filters.dataOrigin) filter.dataOrigin = filters.dataOrigin;
  if (filters.status) filter.status = filters.status;
  if (filters.pending) {
    if (!filters.status) filter.status = { $in: ['aberto', 'em_andamento'] };
    else if (filters.status === 'resolvido') filter._id = { $exists: false };
  }
  if (filters.priority) filter.priority = filters.priority;
  if (filters.category) filter.category = filters.category;
  if (filters.assignee === 'none') filter.assignee = null;
  if (filters.assignee === 'me') filter.assignee = actorId;
  if (filters.createdFrom || filters.createdTo) filter.createdAt = { ...(filters.createdFrom && { $gte: new Date(filters.createdFrom) }), ...(filters.createdTo && { $lt: new Date(filters.createdTo) }) };
  if (filters.attention) {
    const now = new Date();
    filter.$and = [{ status: { $in: ['aberto', 'em_andamento'] } }];
    if (filters.attention === 'high_unassigned') filter.$and.push({ priority: 'alta', assignee: null });
    if (filters.attention === 'oldest') filter.$and.push({ createdAt: { $type: 'date', $lte: daysAgo(filters.ageDays ?? 7, now) } });
    if (filters.attention === 'inactive') filter.$and.push({ $expr: { $and: [
      { $ne: [lastOperationalActivity(now), null] },
      { $lte: [lastOperationalActivity(now), daysAgo(filters.inactivityDays ?? 3, now)] },
    ] } });
    // Same definition as the "Reaberto pelo solicitante" marker: a contest reopened the current cycle.
    if (filters.attention === 'contested') filter.$and.push({ status: 'em_andamento', $expr: { $gt: [{ $size: { $filter: {
      input: { $ifNull: ['$history', []] }, as: 'event',
      cond: { $and: [
        { $eq: ['$$event.type', 'reopened'] },
        { $eq: ['$$event.audit.cycleId', { $ifNull: ['$activeCycleId', 1] }] },
        { $isNumber: '$$event.audit.to.contestedCycle' },
      ] },
    } } }, 0] } });
  }
  // User input is escaped so it is matched literally, not as a regular expression.
  if (filters.search) filter.title = { $regex: escapeRegex(filters.search), $options: 'i' };

  return filter;
}

// ---------- Use cases ----------

/** Validated guided answers and the article read before asking. Nothing is stored when both are empty. */
async function buildIntake(input: CreateTicketInput): Promise<Ticket['intake']> {
  if (!input.intake) return undefined;
  const answers = buildIntakeAnswers(input.category, input.intake.answers);
  let article = null;
  if (input.intake.articleId) {
    const found = await KnowledgeArticleModel.findOne({ _id: input.intake.articleId, status: 'published' }).select('title');
    if (!found) throw new HttpError(400, 'The referenced help article is not available');
    article = { id: found._id, title: found.title };
  }
  return answers.length === 0 && !article ? undefined : { category: input.category, answers, article };
}

export async function createTicket(input: CreateTicketInput, actor: PublicUser): Promise<TicketDetailView> {
  // The requester always comes from the authenticated user, never from the request body.
  const at = new Date();
  const { intake: _guided, ...fields } = input;
  const intake = await buildIntake(input);
  const origin = DEMO_EMAILS.has(actor.email) ? 'demo' : 'operational';
  const ticket = await TicketModel.create({
    ...fields,
    ...(intake && { intake }),
    dataOrigin: origin,
    createdAt: at,
    updatedAt: at,
    requester: actor.id,
    history: [{ type: 'created', author: actor.id, message: 'Chamado aberto', at,
      audit: auditEvent(actor, 'created', at, 0, 1, {}, { status: 'aberto', ...fields }, null, origin, randomUUID(), 0) }],
  });

  return toTicketDetail(ticket, actor);
}

export async function listTickets(
  query: ListTicketsQuery,
  actor: PublicUser,
): Promise<{ tickets: TicketSummaryView[]; pagination: Pagination }> {
  const filter = buildTicketFilter(query, actor);
  const { page, limit } = query;

  const [total, tickets] = await Promise.all([
    TicketModel.countDocuments(filter),
    TicketModel.find(filter)
      .sort(query.attention === 'oldest' || query.sort === 'oldest' ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      // History stays (without messages) to tell whether the requester contested the resolution.
      .select('-description -history.message'),
  ]);

  const users = await loadUsers(tickets.flatMap((ticket) => [ticket.requester, ticket.assignee, ticket.resolvedBy]));

  return {
    tickets: tickets.map((ticket) => toSummaryFor(ticket, users, actor)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTicket(id: string, actor: PublicUser): Promise<TicketDetailView> {
  return toTicketDetail(await findAccessibleTicket(id, actor), actor);
}

// ---------- Updates ----------

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  category?: TicketCategory;
  priority?: TicketPriority;
}

type TicketChanges = Partial<
  Pick<Ticket, 'title' | 'description' | 'category' | 'priority' | 'status' | 'assignee' | 'resolvedBy' | 'resolvedAt' | 'activeCycleId' | 'dataOrigin'>
>;

interface NewEvent {
  type: TicketEventType;
  message: string;
  from?: Record<string, unknown>;
  to?: Record<string, unknown>;
}

/**
 * Applies the changes and appends history events in one atomic update.
 * The filter on the client-validated numeric revision is an optimistic lock:
 * stale/concurrent writes do not change state or history and receive 409.
 */
async function saveChanges(
  ticket: TicketDocument,
  changes: TicketChanges,
  events: NewEvent[],
  actor: PublicUser,
  reason?: string,
): Promise<TicketDetailView> {
  const at = new Date();
  if ((ticket.updatedAt && at < ticket.updatedAt) || ticket.history.some(event => event.at && event.at > at)) {
    throw new HttpError(409, 'Ticket contains future dates. Review data integrity before updating');
  }
  const revision = ticket.revision ?? 0;
  const users = await loadUsers([ticket.requester, ticket.assignee, changes.assignee ?? null]);
  const origin = ticketOrigin(ticket, users);
  const operationId = randomUUID();
  if (changes.resolvedAt) changes.resolvedAt = at;
  // Missing legacy revision is treated as zero, but a later write cannot reuse that baseline.
  const revisionFilter = revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
  const updated = await TicketModel.findOneAndUpdate(
    { _id: ticket._id, ...revisionFilter },
    {
      $set: { ...changes, dataOrigin: origin },
      $inc: { revision: 1 },
      $push: { history: { $each: events.map((event, index) => ({ type: event.type, message: event.message, author: actor.id, at,
        audit: auditEvent(actor, event.type, at, revision + 1, changes.activeCycleId ?? ticket.activeCycleId ?? 1,
          event.from ?? {}, event.to ?? {}, changes.assignee === undefined ? ticket.assignee : changes.assignee,
          origin, operationId, index, reason, userFrom(users, changes.assignee === undefined ? ticket.assignee : changes.assignee)),
      })) } },
    },
    { returnDocument: 'after', runValidators: true },
  );

  if (!updated) {
    throw new HttpError(409, 'Ticket was changed by someone else. Reload and try again');
  }

  return toTicketDetail(updated, actor);
}

/**
 * - Title and description: only the requester, and only while the ticket is open.
 * - Category and priority: TI/manager operators, while the ticket is not resolved.
 * Status and assignee have their own endpoints.
 */
export async function updateTicket(
  id: string,
  input: UpdateTicketInput,
  actor: PublicUser,
  expectedRevision: number,
  reason?: string,
): Promise<TicketDetailView> {
  const ticket = await findAccessibleTicket(id, actor);
  assertRevision(ticket, expectedRevision);

  if (input.title !== undefined || input.description !== undefined) {
    if (!isRequester(ticket, actor)) {
      throw new HttpError(403, 'Only the requester can edit the title and description');
    }
    if (ticket.status !== 'aberto') {
      throw new HttpError(409, 'Title and description can only be edited while the ticket is open');
    }
  }

  if (input.category !== undefined || input.priority !== undefined) {
    if (!can(actor.role, 'tickets:operate')) {
      throw new HttpError(403, 'Only the IT team can change category and priority');
    }
    if (ticket.status === 'resolvido') {
      throw new HttpError(409, 'Resolved tickets cannot be changed');
    }
  }

  if (input.priority !== undefined && input.priority !== ticket.priority && !reason) throw new HttpError(400, 'A reason is required to change priority');
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
  if (messages.length === 0) return toTicketDetail(ticket, actor);

  return saveChanges(ticket, changes, [{ type: 'updated', message: messages.join('; '),
    from: Object.fromEntries(Object.keys(changes).map(key => [key, ticket.get(key)])), to: { ...changes } }], actor, reason);
}

/** TI/manager operators (enforced by the route). Follows STATUS_TRANSITIONS. */
export async function changeStatus(
  id: string,
  status: TicketStatus,
  actor: PublicUser,
  expectedRevision: number,
  reason?: string,
): Promise<TicketDetailView> {
  const ticket = await findAccessibleTicket(id, actor);
  assertRevision(ticket, expectedRevision);
  const from = ticket.status;

  if (!STATUS_TRANSITIONS[from].includes(status)) {
    throw new HttpError(409, `Cannot change status from ${from} to ${status}`);
  }

  if (status === 'resolvido') {
    if (!ticket.assignee) throw new HttpError(409, 'Assign a responsible operator before resolving');
    if (!ticket.assignee.equals(actor.id) && !reason) throw new HttpError(400, "Justification is required when resolving another operator's ticket");
  }
  if (from === 'resolvido' && !reason) throw new HttpError(400, 'A reason is required to reopen a ticket');
  if ((status === 'em_andamento' || status === 'resolvido') && ticket.assignee) {
    const responsible = await UserModel.findById(ticket.assignee);
    if (!responsible?.active || !can(responsible.role, 'tickets:be-assigned')) throw new HttpError(409, 'Reassign to an active operator before starting');
  }
  const reopening = from === 'resolvido';
  const changes: TicketChanges = { status };
  if (status === 'resolvido') { changes.resolvedAt = new Date(); changes.resolvedBy = new Types.ObjectId(actor.id); }
  // Current projection describes one cycle; immutable history remains the source for earlier resolutions.
  if (reopening) { changes.resolvedAt = null; changes.resolvedBy = null; changes.activeCycleId = (ticket.activeCycleId ?? 1) + 1; }
  const events: NewEvent[] = [
    {
      type: reopening ? 'reopened' : status === 'resolvido' ? 'resolved' : 'status_changed',
      from: { status: from }, to: { status },
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

  return saveChanges(ticket, changes, events, actor, reason);
}

/** TI/manager operators (enforced by the route). The assignee must be an active TI/manager operator. */
export async function assignTicket(
  id: string,
  assigneeId: string,
  actor: PublicUser,
  expectedRevision: number,
  reason?: string,
): Promise<TicketDetailView> {
  const ticket = await findAccessibleTicket(id, actor);
  assertRevision(ticket, expectedRevision);

  if (ticket.status === 'resolvido') {
    throw new HttpError(409, 'Resolved tickets cannot be reassigned');
  }

  const assignee = await UserModel.findById(assigneeId);
  if (!assignee || !assignee.active || !can(assignee.role, 'tickets:be-assigned')) {
    throw new HttpError(400, 'Assignee must be an IT team member');
  }

  if (ticket.assignee?.equals(assignee._id)) return toTicketDetail(ticket, actor);

  if (ticket.status === 'em_andamento' && ticket.assignee && !reason) throw new HttpError(400, 'A reason is required to reassign during work');
  const previous = ticket.assignee ? await UserModel.findById(ticket.assignee) : null;
  const message = previous
    ? `Responsável alterado de ${previous.name} para ${assignee.name}`
    : `Responsável definido: ${assignee.name}`;

  return saveChanges(ticket, { assignee: assignee._id }, [{ type: 'assigned', message,
    from: { assigneeId: ticket.assignee?.toString() ?? null }, to: { assigneeId: assignee.id } }], actor, reason);
}

// ---------- Requester answer to a resolution ----------

export const RATING_COMMENT_MAX = 500;

/**
 * Only the requester answers, for the resolution of the current cycle. The cycle sent by the
 * client names the resolution being answered: an older cycle, or a ticket the team already
 * reopened, gets 409 instead of acting on a different resolution.
 */
async function findAnswerableResolution(id: string, actor: PublicUser, cycleId: number): Promise<TicketDocument> {
  const ticket = await findAccessibleTicket(id, actor);
  if (!isRequester(ticket, actor)) throw new HttpError(403, 'Only the requester can answer about the resolution');
  if (ticket.status !== 'resolvido' || (ticket.activeCycleId ?? 1) !== cycleId) {
    throw new HttpError(409, 'This resolution is no longer current. Reload the ticket');
  }
  return ticket;
}

function cycleEvent(ticket: TicketDocument, type: TicketEventType, cycleId: number) {
  return ticket.history.find((event) => event.type === type && event.audit?.cycleId === cycleId);
}

/** "Sim, foi resolvido." Repeating it (double click, retry) changes nothing. */
export async function confirmResolution(id: string, cycleId: number, actor: PublicUser): Promise<TicketDetailView> {
  const ticket = await findAnswerableResolution(id, actor, cycleId);
  if (cycleEvent(ticket, 'resolution_confirmed', cycleId)) return toTicketDetail(ticket, actor);
  return saveChanges(ticket, {}, [{ type: 'resolution_confirmed', message: 'Solicitante confirmou que o problema foi resolvido',
    from: { status: 'resolvido' }, to: { confirmedCycle: cycleId } }], actor);
}

/**
 * "Não, o problema continua." Reopens into a new cycle with the requester as the audited author
 * and the reason; the previous resolution and its author stay in the history. It does not give the
 * requester any general status permission. A second request for the same cycle gets 409.
 */
export async function contestResolution(id: string, cycleId: number, reason: string, actor: PublicUser): Promise<TicketDetailView> {
  const ticket = await findAnswerableResolution(id, actor, cycleId);
  if (cycleEvent(ticket, 'resolution_confirmed', cycleId)) throw new HttpError(409, 'This resolution was already confirmed');
  return saveChanges(ticket, { status: 'em_andamento', resolvedAt: null, resolvedBy: null, activeCycleId: cycleId + 1 },
    [{ type: 'reopened', message: 'Solicitante informou que o problema continua',
      from: { status: 'resolvido', cycleId }, to: { status: 'em_andamento', contestedCycle: cycleId } }], actor, reason);
}

/** Optional 1-5 rating after confirming. One per resolution; not having one means nothing. */
export async function rateResolution(id: string, cycleId: number, rating: number, comment: string | undefined,
  actor: PublicUser): Promise<TicketDetailView> {
  const ticket = await findAnswerableResolution(id, actor, cycleId);
  if (!cycleEvent(ticket, 'resolution_confirmed', cycleId)) throw new HttpError(409, 'Confirm the resolution before rating it');
  if (cycleEvent(ticket, 'resolution_rated', cycleId)) throw new HttpError(409, 'This resolution was already rated');
  return saveChanges(ticket, {}, [{ type: 'resolution_rated', message: 'Solicitante avaliou o atendimento',
    from: {}, to: { rating, ratedCycle: cycleId, ...(comment ? { comment } : {}) } }], actor);
}
