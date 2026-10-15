import { Types } from 'mongoose';
import { can } from '../auth/permissions';
import { HttpError } from '../errors/http-error';
import {
  IncidentParticipationModel,
  SharedIncidentModel,
  type IncidentCloseReason,
  type IncidentEventType,
  type IncidentStatus,
  type SharedIncidentDocument,
} from '../models/incident.model';
import { TicketModel, type TicketCategory, type TicketDocument, type TicketPriority, type TicketStatus } from '../models/ticket.model';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.model';
import { findAccessibleTicket } from './ticket.service';

/** Shown to followers when the incident closes because its main ticket was resolved. */
export const DEFAULT_RESOLUTION_MESSAGE = 'A equipe de TI concluiu o atendimento deste problema.';

// ---------- Response shapes ----------

/**
 * The only shape a requester ever receives. Built field by field from the incident document,
 * which does not hold the private ticket description, its history or anyone's identity.
 */
export interface PublicIncident {
  id: string;
  title: string;
  publicMessage: string;
  status: IncidentStatus;
  publishedAt: Date;
  closedAt: Date | null;
  resolutionMessage: string | null;
  affectedCount: number;
  /** The authenticated user follows the current publication cycle. */
  following: boolean;
  /**
   * Subject of the problem (category of the main ticket, read now, so a correction by the team
   * shows up). Only the area, never the ticket itself. Used to suggest it in the request form.
   */
  category: TicketCategory | null;
}

export interface IncidentEventView {
  type: IncidentEventType;
  at: Date;
  actor: { id: string; name: string; role: string };
  revision: number;
  cycle: number;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

/** Operational view for TI and managers: the public fields plus the main ticket and the audit. */
export interface ManagedIncident extends Omit<PublicIncident, 'following'> {
  ticketId: string;
  ticketTitle: string;
  ticketStatus: TicketStatus | null;
  ticketPriority: TicketPriority | null;
  assignee: PublicUser | null;
  cycle: number;
  revision: number;
  publishedBy: PublicUser | null;
  closedBy: PublicUser | null;
  closeReason: IncidentCloseReason | null;
  dataOrigin: 'operational' | 'demo' | 'legacy';
  history: IncidentEventView[];
}

export interface IncidentBadge {
  id: string;
  status: IncidentStatus;
  affectedCount: number;
}

export interface PublishIncidentInput {
  title: string;
  publicMessage: string;
}

// ---------- Helpers ----------

const ACTIVE_PARTICIPATION = { leftAt: null };

function objectId(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}

/** Affected people per incident, counted from valid participation rows of the current cycle. */
async function countAffected(incidents: SharedIncidentDocument[]): Promise<Map<string, number>> {
  if (incidents.length === 0) return new Map();
  const rows = await IncidentParticipationModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { ...ACTIVE_PARTICIPATION, $or: incidents.map((incident) => ({ incident: incident._id, cycle: incident.cycle })) } },
    { $group: { _id: '$incident', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

async function followedBy(actor: PublicUser, incidents: SharedIncidentDocument[]): Promise<Set<string>> {
  if (incidents.length === 0) return new Set();
  const rows = await IncidentParticipationModel.find({
    user: objectId(actor.id),
    ...ACTIVE_PARTICIPATION,
    $or: incidents.map((incident) => ({ incident: incident._id, cycle: incident.cycle })),
  }).select('incident');
  return new Set(rows.map((row) => row.incident.toString()));
}

function toPublic(incident: SharedIncidentDocument, affected: Map<string, number>, following: Set<string>,
  categories: Map<string, TicketCategory>): PublicIncident {
  return {
    id: incident.id,
    title: incident.title,
    publicMessage: incident.publicMessage,
    status: incident.status,
    publishedAt: incident.publishedAt,
    closedAt: incident.closedAt,
    resolutionMessage: incident.resolutionMessage,
    affectedCount: affected.get(incident.id) ?? 0,
    following: following.has(incident.id),
    category: categories.get(incident.ticket.toString()) ?? null,
  };
}

function event(actor: PublicUser, type: IncidentEventType, at: Date, revision: number, cycle: number,
  from: Record<string, unknown>, to: Record<string, unknown>) {
  return { type, actorId: objectId(actor.id), actorSnapshot: { name: actor.name, role: actor.role }, at, revision, cycle, from, to };
}

function conflict(): HttpError {
  return new HttpError(409, 'Incident was changed by someone else. Reload and try again');
}

async function findIncident(id: string): Promise<SharedIncidentDocument> {
  const incident = await SharedIncidentModel.findById(id);
  if (!incident) throw new HttpError(404, 'Incident not found');
  return incident;
}

type TicketForReconcile = Pick<TicketDocument, 'status' | 'resolvedBy' | 'history'>;

/**
 * The resolution that should have closed this publication: the ticket is resolved now, or it was
 * resolved after the incident was (re)published and reopened before the close was written.
 */
function missedResolution(incident: SharedIncidentDocument, ticket: TicketForReconcile | undefined):
  { resolverId: Types.ObjectId | null; at: Date | null } | null {
  if (!ticket || incident.status !== 'active') return null;
  const resolution = ticket.history.filter((item) => item.type === 'resolved' && item.at && item.at >= incident.publishedAt).at(-1);
  if (resolution) return { resolverId: resolution.author ?? ticket.resolvedBy ?? null, at: resolution.at ?? null };
  return ticket.status === 'resolvido' ? { resolverId: ticket.resolvedBy ?? null, at: null } : null;
}

/**
 * Closing a ticket and its incident are two writes without a transaction (the local MongoDB is
 * standalone). If the second write was lost, this repairs it on read, attributed to who resolved
 * the ticket. Even when the repair cannot be written either, the returned documents show the
 * incident as closed: an incident is never presented as active once its main ticket was resolved.
 * The in-memory correction is never saved; only closeAtomically writes.
 */
async function reconcile(incidents: SharedIncidentDocument[]): Promise<SharedIncidentDocument[]> {
  const active = incidents.filter((incident) => incident.status === 'active');
  if (active.length === 0) return incidents;
  const tickets = new Map((await TicketModel.find({ _id: { $in: active.map((incident) => incident.ticket) } })
    .select('status resolvedBy history.type history.at history.author'))
    .map((ticket) => [ticket.id, ticket as TicketForReconcile]));
  const ticketOf = (incident: SharedIncidentDocument) => tickets.get(incident.ticket.toString());
  const missed = active.flatMap((incident) => {
    const resolution = missedResolution(incident, ticketOf(incident));
    return resolution ? [{ incident, ...resolution }] : [];
  });
  if (missed.length === 0) return incidents;

  const people = await loadPeople(missed.flatMap(({ incident, resolverId }) => [resolverId, incident.publishedBy]));
  for (const { incident, resolverId } of missed) {
    // Who resolved the ticket closes the incident; if unknown, the publisher (or a removed-user marker).
    const actorId = resolverId ?? incident.publishedBy;
    const actor = people.get(actorId.toString())
      ?? { id: actorId.toString(), name: 'Usuário removido', email: '', role: 'ti' as const };
    try {
      await closeAtomically(incident, actor, 'ticket_resolved', DEFAULT_RESOLUTION_MESSAGE);
    } catch (error) {
      // Reading must not fail because the repair failed; the next read tries again.
      console.error('Could not repair the close of a shared incident:', error);
    }
  }

  const current = await SharedIncidentModel.find({ _id: { $in: incidents.map((incident) => incident._id) } }).sort({ publishedAt: -1 });
  for (const incident of current) {
    const resolution = missedResolution(incident, ticketOf(incident));
    if (!resolution) continue;
    incident.set({ status: 'closed', closeReason: 'ticket_resolved', resolutionMessage: DEFAULT_RESOLUTION_MESSAGE,
      closedAt: resolution.at ?? new Date(), closedBy: resolution.resolverId ?? incident.publishedBy });
  }
  return current;
}

/**
 * Closes the incident if it is still active. With expectedRevision (manual close) a stale revision
 * fails; without it (automatic close after resolving the ticket) it retries on the current revision,
 * so the audit event always records the revision it produced.
 * Returns false when the incident was already closed.
 */
async function closeAtomically(incident: SharedIncidentDocument, actor: PublicUser, reason: IncidentCloseReason,
  resolutionMessage: string, expectedRevision?: number): Promise<boolean> {
  let current: SharedIncidentDocument | null = incident;
  for (let attempt = 0; attempt < 5 && current; attempt += 1) {
    if (current.status !== 'active') return false;
    const revision = expectedRevision ?? current.revision;
    const at = new Date();
    const updated = await SharedIncidentModel.findOneAndUpdate(
      { _id: current._id, status: 'active', revision },
      {
        $set: { status: 'closed', closedAt: at, closedBy: objectId(actor.id), closeReason: reason, resolutionMessage },
        $inc: { revision: 1 },
        $push: { history: event(actor, 'closed', at, revision + 1, current.cycle,
          { status: 'active' }, { status: 'closed', closeReason: reason, resolutionMessage }) },
      },
      { returnDocument: 'after', runValidators: true },
    );
    if (updated) return true;
    if (expectedRevision !== undefined) return false;
    current = await SharedIncidentModel.findById(incident._id);
  }
  return false;
}

async function loadPeople(ids: (Types.ObjectId | null | undefined)[]): Promise<Map<string, PublicUser>> {
  const unique = [...new Set(ids.filter((id): id is Types.ObjectId => id != null).map(String))];
  const users = await UserModel.find({ _id: { $in: unique } });
  return new Map(users.map((user) => [user.id, toPublicUser(user)]));
}

async function toManaged(incidents: SharedIncidentDocument[]): Promise<ManagedIncident[]> {
  const affected = await countAffected(incidents);
  const tickets = new Map((await TicketModel.find({ _id: { $in: incidents.map((incident) => incident.ticket) } })
    .select('title status priority assignee category')).map((ticket) => [ticket.id, ticket]));
  const people = await loadPeople([
    ...incidents.flatMap((incident) => [incident.publishedBy, incident.closedBy]),
    ...[...tickets.values()].map((ticket) => ticket.assignee),
  ]);
  return incidents.map((incident) => {
    const ticket = tickets.get(incident.ticket.toString());
    return {
      id: incident.id,
      title: incident.title,
      publicMessage: incident.publicMessage,
      status: incident.status,
      publishedAt: incident.publishedAt,
      closedAt: incident.closedAt,
      resolutionMessage: incident.resolutionMessage,
      affectedCount: affected.get(incident.id) ?? 0,
      ticketId: incident.ticket.toString(),
      ticketTitle: ticket?.title ?? 'Chamado removido',
      ticketStatus: ticket?.status ?? null,
      ticketPriority: ticket?.priority ?? null,
      category: ticket?.category ?? null,
      assignee: ticket?.assignee ? people.get(ticket.assignee.toString()) ?? null : null,
      cycle: incident.cycle,
      revision: incident.revision,
      publishedBy: people.get(incident.publishedBy.toString()) ?? null,
      closedBy: incident.closedBy ? people.get(incident.closedBy.toString()) ?? null : null,
      closeReason: incident.closeReason,
      dataOrigin: incident.dataOrigin,
      history: incident.history.map((item) => ({
        type: item.type,
        at: item.at,
        actor: { id: item.actorId.toString(), ...item.actorSnapshot },
        revision: item.revision,
        cycle: item.cycle,
        from: item.from,
        to: item.to,
      })),
    };
  });
}

async function publicView(incidents: SharedIncidentDocument[], actor: PublicUser): Promise<PublicIncident[]> {
  const [affected, following, tickets] = await Promise.all([
    countAffected(incidents),
    followedBy(actor, incidents),
    TicketModel.find({ _id: { $in: incidents.map((incident) => incident.ticket) } }).select('category'),
  ]);
  const categories = new Map(tickets.map((ticket) => [ticket.id, ticket.category]));
  return incidents.map((incident) => toPublic(incident, affected, following, categories));
}

// ---------- Public use cases (any authenticated user) ----------

/** Active incidents, newest first. Public fields only. */
export async function listActive(actor: PublicUser): Promise<PublicIncident[]> {
  const incidents = await reconcile(await SharedIncidentModel.find({ status: 'active' }).sort({ publishedAt: -1 }));
  return publicView(incidents.filter((incident) => incident.status === 'active'), actor);
}

/** Incidents the user follows, including closed ones, so they can read how it ended. */
export async function listFollowed(actor: PublicUser): Promise<PublicIncident[]> {
  const rows = await IncidentParticipationModel.find({ user: objectId(actor.id), ...ACTIVE_PARTICIPATION }).select('incident cycle');
  if (rows.length === 0) return [];
  // `following` refers to the current cycle: after a republication the person confirms again.
  const incidents = await reconcile(await SharedIncidentModel.find({ _id: { $in: rows.map((row) => row.incident) } }).sort({ publishedAt: -1 }));
  return publicView(incidents, actor);
}

/** Active incidents are public; a closed one is visible to people who followed it and to the team. */
export async function getPublic(id: string, actor: PublicUser): Promise<PublicIncident> {
  const [incident] = await reconcile([await findIncident(id)]);
  if (incident.status === 'closed' && !can(actor.role, 'incidents:manage')) {
    const followedAnyCycle = await IncidentParticipationModel.exists({ incident: incident._id, user: objectId(actor.id), ...ACTIVE_PARTICIPATION });
    if (!followedAnyCycle) throw new HttpError(404, 'Incident not found');
  }
  const [view] = await publicView([incident], actor);
  return view;
}

/**
 * "I am affected too". Idempotent: the unique index (incident, cycle, user) makes repeated or
 * simultaneous clicks land on the same row. The user always comes from the token.
 */
export async function follow(id: string, actor: PublicUser): Promise<PublicIncident> {
  const [incident] = await reconcile([await findIncident(id)]);
  if (incident.status !== 'active') throw new HttpError(409, 'This incident is already closed');

  const key = { incident: incident._id, cycle: incident.cycle, user: objectId(actor.id) };
  try {
    await IncidentParticipationModel.updateOne(key, { $set: { leftAt: null }, $setOnInsert: { joinedAt: new Date() } }, { upsert: true });
  } catch (error) {
    // Two simultaneous upserts may race on the unique index; the row exists either way.
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
    await IncidentParticipationModel.updateOne(key, { $set: { leftAt: null } });
  }

  // The incident may have closed (or been republished), or its ticket been resolved, between the check and the write.
  const [current] = await reconcile([await findIncident(id)]);
  if (current.status !== 'active' || current.cycle !== incident.cycle) {
    await IncidentParticipationModel.updateOne(key, { $set: { leftAt: new Date() } });
    throw new HttpError(409, 'This incident is already closed');
  }
  const [view] = await publicView([current], actor);
  return view;
}

/** "This no longer affects me". Idempotent; joining again later reuses the same row. */
export async function unfollow(id: string, actor: PublicUser): Promise<PublicIncident> {
  const [incident] = await reconcile([await findIncident(id)]);
  if (incident.status !== 'active') throw new HttpError(409, 'This incident is already closed');
  await IncidentParticipationModel.updateOne(
    { incident: incident._id, cycle: incident.cycle, user: objectId(actor.id), ...ACTIVE_PARTICIPATION },
    { $set: { leftAt: new Date() } },
  );
  const [view] = await publicView([incident], actor);
  return view;
}

// ---------- Team use cases (incidents:manage, enforced by the routes) ----------

export async function listManaged(filters: { status?: IncidentStatus; dataOrigin?: SharedIncidentDocument['dataOrigin'] }): Promise<ManagedIncident[]> {
  const incidents = await reconcile(await SharedIncidentModel.find({
    ...(filters.dataOrigin ? { dataOrigin: filters.dataOrigin } : {}),
  }).sort({ publishedAt: -1 }));
  const managed = await toManaged(incidents.filter((incident) => !filters.status || incident.status === filters.status));
  // Active first, then by number of affected people.
  return managed.sort((a, b) => (a.status === b.status ? b.affectedCount - a.affectedCount : a.status === 'active' ? -1 : 1));
}

export async function getForTicket(ticketId: string, actor: PublicUser): Promise<ManagedIncident | null> {
  const ticket = await findAccessibleTicket(ticketId, actor);
  const incident = await SharedIncidentModel.findOne({ ticket: ticket._id });
  if (!incident) return null;
  const [reconciled] = await reconcile([incident]);
  const [managed] = await toManaged([reconciled]);
  return managed;
}

/** Small marker for the operational ticket list. */
export async function badgesForTickets(ticketIds: string[]): Promise<Map<string, IncidentBadge>> {
  if (ticketIds.length === 0) return new Map();
  const incidents = await reconcile(await SharedIncidentModel.find({ ticket: { $in: ticketIds.map(objectId) } }));
  const affected = await countAffected(incidents);
  return new Map(incidents.map((incident) => [incident.ticket.toString(),
    { id: incident.id, status: incident.status, affectedCount: affected.get(incident.id) ?? 0 }]));
}

function ensureOpenTicket(ticket: TicketDocument): void {
  if (ticket.status === 'resolvido') throw new HttpError(409, 'Resolved tickets cannot publish a shared incident');
}

export async function publish(ticketId: string, input: PublishIncidentInput, actor: PublicUser): Promise<ManagedIncident> {
  const ticket = await findAccessibleTicket(ticketId, actor);
  ensureOpenTicket(ticket);
  const existing = await SharedIncidentModel.findOne({ ticket: ticket._id }).select('status');
  if (existing) {
    throw new HttpError(409, existing.status === 'active'
      ? 'This ticket already has an active shared incident'
      : 'This ticket already had a shared incident. Republish it instead');
  }
  const at = new Date();
  try {
    const incident = await SharedIncidentModel.create({
      ticket: ticket._id,
      title: input.title,
      publicMessage: input.publicMessage,
      status: 'active',
      cycle: 1,
      publishedBy: objectId(actor.id),
      publishedAt: at,
      revision: 1,
      dataOrigin: ticket.dataOrigin === 'demo' ? 'demo' : 'operational',
      history: [event(actor, 'published', at, 1, 1, {}, { title: input.title, publicMessage: input.publicMessage })],
    });
    // A resolution written after the open-ticket check closes it right away.
    const [managed] = await toManaged(await reconcile([incident]));
    return managed;
  } catch (error) {
    // The unique index on ticket wins a race between two simultaneous publications.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw new HttpError(409, 'This ticket already has an active shared incident');
    }
    throw error;
  }
}

export async function updatePublicText(id: string, input: Partial<PublishIncidentInput>, expectedRevision: number,
  actor: PublicUser): Promise<ManagedIncident> {
  const [incident] = await reconcile([await findIncident(id)]);
  if (incident.status !== 'active') throw new HttpError(409, 'Only active incidents can be edited');
  if (incident.revision !== expectedRevision) throw conflict();

  const changes: Partial<PublishIncidentInput> = {};
  if (input.title !== undefined && input.title !== incident.title) changes.title = input.title;
  if (input.publicMessage !== undefined && input.publicMessage !== incident.publicMessage) changes.publicMessage = input.publicMessage;
  if (Object.keys(changes).length === 0) {
    const [managed] = await toManaged([incident]);
    return managed;
  }

  const at = new Date();
  const from = Object.fromEntries(Object.keys(changes).map((key) => [key, incident.get(key)]));
  const updated = await SharedIncidentModel.findOneAndUpdate(
    { _id: incident._id, status: 'active', revision: expectedRevision },
    {
      $set: changes,
      $inc: { revision: 1 },
      $push: { history: event(actor, 'updated', at, expectedRevision + 1, incident.cycle, from, { ...changes }) },
    },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) throw conflict();
  const [managed] = await toManaged([updated]);
  return managed;
}

export async function closeManually(id: string, resolutionMessage: string, expectedRevision: number,
  actor: PublicUser): Promise<ManagedIncident> {
  const [incident] = await reconcile([await findIncident(id)]);
  if (incident.status !== 'active') throw new HttpError(409, 'This incident is already closed');
  if (incident.revision !== expectedRevision) throw conflict();
  if (!(await closeAtomically(incident, actor, 'manual', resolutionMessage, expectedRevision))) throw conflict();
  const [managed] = await toManaged([await findIncident(id)]);
  return managed;
}

/**
 * Reopening the main ticket does not bring an old message back. The team reviews the text and
 * republishes, which starts a new cycle: people confirm again that they are affected.
 */
export async function republish(id: string, input: PublishIncidentInput, expectedRevision: number,
  actor: PublicUser): Promise<ManagedIncident> {
  const [incident] = await reconcile([await findIncident(id)]);
  if (incident.status !== 'closed') throw new HttpError(409, 'Only closed incidents can be republished');
  if (incident.revision !== expectedRevision) throw conflict();
  const ticket = await TicketModel.findById(incident.ticket).select('status');
  if (!ticket || ticket.status === 'resolvido') throw new HttpError(409, 'Reopen the main ticket before republishing');

  const at = new Date();
  const cycle = incident.cycle + 1;
  const updated = await SharedIncidentModel.findOneAndUpdate(
    { _id: incident._id, status: 'closed', revision: expectedRevision },
    {
      $set: { status: 'active', cycle, title: input.title, publicMessage: input.publicMessage, publishedAt: at,
        publishedBy: objectId(actor.id), closedAt: null, closedBy: null, closeReason: null, resolutionMessage: null },
      $inc: { revision: 1 },
      $push: { history: event(actor, 'republished', at, expectedRevision + 1, cycle,
        { status: 'closed', title: incident.title, publicMessage: incident.publicMessage },
        { status: 'active', title: input.title, publicMessage: input.publicMessage }) },
    },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) throw conflict();
  // A resolution written after the reopened-ticket check closes it right away.
  const [managed] = await toManaged(await reconcile([updated]));
  return managed;
}

/** Called right after the main ticket is resolved. Safe to call when there is no active incident. */
export async function closeForResolvedTicket(ticketId: string, actor: PublicUser): Promise<void> {
  const incident = await SharedIncidentModel.findOne({ ticket: objectId(ticketId), status: 'active' });
  if (incident) await closeAtomically(incident, actor, 'ticket_resolved', DEFAULT_RESOLUTION_MESSAGE);
}

// ---------- Indicators ----------

export interface IncidentIndicators {
  active: number;
  closed: number;
  affectedInActive: number;
  /** People who joined an incident in the last 30 days (first join per person and cycle). */
  newParticipations30Days: number;
  top: ManagedIncident[];
}

export async function indicators(dataOrigin?: SharedIncidentDocument['dataOrigin']): Promise<IncidentIndicators> {
  const all = await listManaged({ dataOrigin });
  const active = all.filter((incident) => incident.status === 'active');
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const newParticipations30Days = all.length === 0 ? 0 : await IncidentParticipationModel.countDocuments({
    incident: { $in: all.map((incident) => objectId(incident.id)) },
    joinedAt: { $gte: since },
  });
  return {
    active: active.length,
    closed: all.length - active.length,
    affectedInActive: active.reduce((sum, incident) => sum + incident.affectedCount, 0),
    newParticipations30Days,
    top: active.slice(0, 5),
  };
}
