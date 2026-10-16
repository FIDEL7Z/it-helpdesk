import { Types, type PipelineStage } from 'mongoose';
import { daysAgo, lastOperationalActivity } from './activity';
import { env } from '../config/env';
import { assessWorkload } from './workload-balance';
import { TicketModel, type TicketCategory, type TicketPriority, type TicketStatus } from '../models/ticket.model';
import { UserModel } from '../models/user.model';

export const PERIODS = ['today', 'week', 'month', 'year'] as const;
export type ManagerFilters = {
  period: (typeof PERIODS)[number]; dataOrigin: 'operational' | 'demo' | 'legacy';
  ageDays?: number; inactivityDays?: number; analystId?: string; requesterId?: string; category?: TicketCategory; priority?: TicketPriority; status?: TicketStatus;
};

/** Calendar boundaries in an IANA zone, including zones with daylight saving time. */
export function periodRange(period: ManagerFilters['period'], now = new Date(), timezone = env.APP_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = (date: Date) => Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const local = parts(now);
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (period === 'week') day.setUTCDate(day.getUTCDate() - 6);
  if (period === 'month') day.setUTCDate(1);
  if (period === 'year') { day.setUTCMonth(0); day.setUTCDate(1); }
  const wall = day.getTime();
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(instant));
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const adjustment = wall - represented;
    instant += adjustment;
    if (!adjustment) break;
  }
  return { start: new Date(instant), end: now, timezone, bucket: period === 'year' ? 'month' as const : 'day' as const };
}

/**
 * Every local day (or month, for the year) from the start of the range to the query instant, with the
 * same keys as the $dateToString buckets. Days without records stay in the series with zero, so the
 * chart shows real gaps instead of joining distant points; nothing else is added.
 */
export function calendarKeys(range: { start: Date; end: Date; timezone: string; bucket: 'day' | 'month' }): string[] {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: range.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const local = (date: Date) => Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const first = local(range.start);
  const last = local(new Date(Math.max(range.start.getTime(), range.end.getTime() - 1)));
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(first.year, first.month - 1, range.bucket === 'month' ? 1 : first.day));
  const stop = Date.UTC(last.year, last.month - 1, range.bucket === 'month' ? 1 : last.day);
  while (cursor.getTime() <= stop) {
    const iso = cursor.toISOString();
    keys.push(range.bucket === 'month' ? iso.slice(0, 7) : iso.slice(0, 10));
    if (range.bucket === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

type Count = { _id: string | number | null; count: number };
type Load = { _id: Types.ObjectId | null; assigned: number; inProgress: number; pending: number; highPriority: number; lowPriority: number; mediumPriority: number };
type Requester = { _id: Types.ObjectId; created: number; pending: number; categories: { category: string; count: number }[] };
type Actor = { _id: Types.ObjectId; count: number; name: string; role: string };
type CycleKey = { ticket: Types.ObjectId; cycle: number };
type EventFacets = { resolutions: Actor[]; participation: Actor[]; reopenings: Actor[]; trends: Count[]; conflicts: Count[]; uniqueTickets: Count[]; currentVerified: Count[]; resolvedCycles: { _id: CycleKey }[] };
type Answer = { _id: CycleKey; confirmed: number; contested: number; rating: number | null };

/** Current assignee measures load; historical actor measures actions, so they use separate scopes. */
export async function getManagerDashboard(filters: ManagerFilters, now = new Date()) {
  const range = periodRange(filters.period, now);
  const common: Record<string, unknown> = filters.dataOrigin === 'legacy'
    ? { $or: [{ dataOrigin: 'legacy' }, { dataOrigin: { $exists: false } }] } : { dataOrigin: filters.dataOrigin };
  for (const key of ['category', 'priority', 'status'] as const) if (filters[key]) common[key] = filters[key];
  if (filters.requesterId) common.requester = new Types.ObjectId(filters.requesterId);
  const current = filters.analystId ? { ...common, assignee: new Types.ObjectId(filters.analystId) } : common;
  const dates = { $gte: range.start, $lt: range.end };
  const bucket = (field: string) => ({ $dateToString: { date: field, format: range.bucket === 'month' ? '%Y-%m' : '%Y-%m-%d', timezone: range.timezone } });
  const grouped = (field: string): PipelineStage.FacetPipelineStage[] => [{ $group: { _id: field, count: { $sum: 1 } } }, { $sort: { _id: 1 } }];
  const created: PipelineStage.FacetPipelineStage = { $match: { createdAt: dates } };
  const pending = { $in: ['$status', ['aberto', 'em_andamento']] };
  const actorCounts = (): PipelineStage.FacetPipelineStage[] => [
    { $group: { _id: '$actor', count: { $sum: 1 }, name: { $last: '$snapshot.name' }, role: { $last: '$snapshot.role' } } },
  ];
  const resolution: PipelineStage.FacetPipelineStage[] = [
    { $match: { 'history.audit.eventType': 'resolved', 'history.audit.to.status': 'resolvido', 'history.audit.from.status': 'em_andamento' } },
    // One proved resolution per ticket and cycle; contradictory actors are excluded.
    { $group: { _id: { ticket: '$_id', cycle: '$history.audit.cycleId' }, actors: { $addToSet: '$history.audit.actorId' }, actor: { $first: '$history.audit.actorId' }, snapshot: { $first: '$history.audit.actorSnapshot' }, at: { $min: '$history.audit.occurredAt' }, currentStatus: { $first: '$status' }, activeCycle: { $first: '$activeCycleId' }, assignee: { $first: '$assignee' } } },
  ];
  // Apply the period after cycle deduplication so repeated evidence cannot shift productivity to another period.
  const verified: PipelineStage.FacetPipelineStage[] = [
    { $match: { 'actors.1': { $exists: false }, at: dates, ...(filters.analystId && { actor: new Types.ObjectId(filters.analystId) }) } },
  ];
  const [[snapshot], [events], users, answers] = await Promise.all([
    TicketModel.aggregate<{
      states: Count[]; priority: Count[]; category: Count[]; loads: Load[]; created: Count[];
      requesters: Requester[]; trends: Count[]; hours: Count[]; weekdays: Count[]; createdCategories: Count[]; incomplete: Count[]; highUnassigned: Count[]; oldPending: Count[]; inactive: Count[]; unknownActivity: Count[]; oldest: { _id: Types.ObjectId; title: string; createdAt: Date; lastOperationalAt: Date | null }[];
    }>([{ $match: current }, { $addFields: { lastOperationalAt: lastOperationalActivity(now) } }, { $facet: {
      states: grouped('$status'),
      highUnassigned: [{ $match: { status: { $in: ['aberto', 'em_andamento'] }, priority: 'alta', assignee: null } }, { $count: 'count' }],
      oldPending: [{ $match: { status: { $in: ['aberto', 'em_andamento'] }, createdAt: { $type: 'date', $lte: daysAgo(filters.ageDays ?? 7, now) } } }, { $count: 'count' }],
      inactive: [{ $match: { status: { $in: ['aberto', 'em_andamento'] }, lastOperationalAt: { $type: 'date', $lte: daysAgo(filters.inactivityDays ?? 3, now) } } }, { $count: 'count' }],
      unknownActivity: [{ $match: { status: { $in: ['aberto', 'em_andamento'] }, lastOperationalAt: null } }, { $count: 'count' }],
      oldest: [{ $match: { status: { $in: ['aberto', 'em_andamento'] }, createdAt: { $type: 'date', $lte: now } } }, { $sort: { createdAt: 1, _id: 1 } }, { $limit: 5 }, { $project: { title: 1, createdAt: 1, lastOperationalAt: 1 } }],
      priority: [{ $match: { status: { $in: ['aberto', 'em_andamento'] } } }, ...grouped('$priority')],
      category: [{ $match: { status: { $in: ['aberto', 'em_andamento'] } } }, ...grouped('$category')],
      loads: [{ $group: { _id: '$assignee', assigned: { $sum: 1 }, highPriority: { $sum: { $cond: [{ $and: [pending, { $eq: ['$priority', 'alta'] }] }, 1, 0] } }, mediumPriority: { $sum: { $cond: [{ $and: [pending, { $eq: ['$priority', 'media'] }] }, 1, 0] } }, lowPriority: { $sum: { $cond: [{ $and: [pending, { $eq: ['$priority', 'baixa'] }] }, 1, 0] } }, pending: { $sum: { $cond: [pending, 1, 0] } }, inProgress: { $sum: { $cond: [{ $eq: ['$status', 'em_andamento'] }, 1, 0] } } } }],
      created: [created, { $count: 'count' }],
      requesters: [created, { $group: { _id: { requester: '$requester', category: '$category' }, count: { $sum: 1 }, pending: { $sum: { $cond: [pending, 1, 0] } } } }, { $sort: { count: -1, '_id.category': 1 } }, { $group: { _id: '$_id.requester', created: { $sum: '$count' }, pending: { $sum: '$pending' }, categories: { $push: { category: '$_id.category', count: '$count' } } } }, { $sort: { created: -1, _id: 1 } }, { $limit: 10 }],
      trends: [created, { $group: { _id: bucket('$createdAt'), count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      hours: [created, { $group: { _id: { $hour: { date: '$createdAt', timezone: range.timezone } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      weekdays: [created, { $group: { _id: { $isoDayOfWeek: { date: '$createdAt', timezone: range.timezone } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      // Subjects that generate requests: creations in the period by category (not the current backlog).
      createdCategories: [created, { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
    } }]),
    TicketModel.aggregate<EventFacets>([{ $match: common }, { $project: { history: 1, status: 1, assignee: 1, activeCycleId: 1, dataOrigin: 1 } }, { $unwind: '$history' },
      { $match: { 'history.audit.schemaVersion': 2, 'history.audit.actorId': { $type: 'objectId' }, 'history.audit.eventId': { $type: 'string', $ne: '' }, 'history.audit.cycleId': { $gte: 1 }, 'history.audit.actorSnapshot.role': { $in: ['ti', 'gestor'] }, 'history.audit.occurredAt': { $type: 'date', $lte: now },
        $expr: { $and: [{ $eq: ['$history.author', '$history.audit.actorId'] }, { $eq: ['$history.type', '$history.audit.eventType'] }, { $eq: ['$history.at', '$history.audit.occurredAt'] }, { $eq: ['$history.audit.dataOrigin', { $ifNull: ['$dataOrigin', 'legacy'] }] }] } } },
      { $facet: {
        resolutions: [...resolution, ...verified, ...actorCounts()],
        uniqueTickets: [...resolution, ...verified, { $group: { _id: '$_id.ticket' } }, { $count: 'count' }],
        conflicts: [...resolution, { $match: { 'actors.1': { $exists: true }, at: dates } }, { $count: 'count' }],
        currentVerified: [...resolution, { $match: { 'actors.1': { $exists: false }, currentStatus: 'resolvido', $expr: { $eq: ['$_id.cycle', '$activeCycle'] }, ...(filters.analystId && { assignee: new Types.ObjectId(filters.analystId) }) } }, { $count: 'count' }],
        trends: [...resolution, ...verified, { $group: { _id: bucket('$at'), count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        participation: [{ $match: { 'history.audit.occurredAt': dates, ...(filters.analystId && { 'history.audit.actorId': new Types.ObjectId(filters.analystId) }) } }, { $group: { _id: { ticket: '$_id', actor: '$history.audit.actorId' }, actor: { $first: '$history.audit.actorId' }, snapshot: { $last: '$history.audit.actorSnapshot' } } }, ...actorCounts()],
        // Which resolutions (ticket + cycle) the quality section measures: the same proved ones as above.
        resolvedCycles: [...resolution, ...verified, { $project: { _id: 1 } }],
        reopenings: [{ $match: { 'history.audit.eventType': 'reopened', 'history.audit.from.status': 'resolvido', 'history.audit.to.status': 'em_andamento' } }, { $group: { _id: { ticket: '$_id', cycle: '$history.audit.cycleId' }, actors: { $addToSet: '$history.audit.actorId' }, actor: { $first: '$history.audit.actorId' }, snapshot: { $first: '$history.audit.actorSnapshot' }, at: { $min: '$history.audit.occurredAt' } } }, ...verified, ...actorCounts()],
      } },
    ]),
    UserModel.find().select('name role active').lean(),
    // The requester's answer to each resolution: confirmed, contested (reopened by the requester) and rating.
    // Only events written by the requester of the ticket count; the team cannot answer for them.
    TicketModel.aggregate<Answer>([{ $match: common }, { $project: { requester: 1, history: 1 } }, { $unwind: '$history' },
      { $match: { 'history.audit.schemaVersion': 2, 'history.audit.occurredAt': { $type: 'date', $lte: now },
        $or: [{ 'history.audit.eventType': { $in: ['resolution_confirmed', 'resolution_rated'] } }, { 'history.audit.eventType': 'reopened', 'history.audit.to.contestedCycle': { $type: 'number' } }],
        $expr: { $and: [{ $eq: ['$history.author', '$requester'] }, { $eq: ['$history.author', '$history.audit.actorId'] }, { $eq: ['$history.type', '$history.audit.eventType'] }] } } },
      { $group: {
        _id: { ticket: '$_id', cycle: { $cond: [{ $eq: ['$history.audit.eventType', 'reopened'] }, '$history.audit.to.contestedCycle', '$history.audit.cycleId'] } },
        confirmed: { $max: { $cond: [{ $eq: ['$history.audit.eventType', 'resolution_confirmed'] }, 1, 0] } },
        contested: { $max: { $cond: [{ $eq: ['$history.audit.eventType', 'reopened'] }, 1, 0] } },
        rating: { $max: { $cond: [{ $eq: ['$history.audit.eventType', 'resolution_rated'] }, '$history.audit.to.rating', null] } },
      } },
    ]),
  ]);
  const userMap = new Map(users.map(user => [user._id.toString(), user]));
  const ids = new Set(users.filter(u => ['ti', 'gestor'].includes(u.role)).map(u => u._id.toString()));
  for (const rows of [events.resolutions, events.participation, events.reopenings]) for (const row of rows) ids.add(row._id.toString());
  for (const load of snapshot.loads) if (load._id) ids.add(load._id.toString());
  const eventRow = (rows: Actor[], id: string) => rows.find(row => row._id.toString() === id);
  const count = (rows: Count[]) => rows[0]?.count ?? 0;
  const state = (status: string) => snapshot.states.find(row => row._id === status)?.count ?? 0;
  const team = [...ids].filter(id => !filters.analystId || id === filters.analystId).map(id => {
    const user = userMap.get(id);
    const evidence = eventRow(events.resolutions, id) ?? eventRow(events.participation, id) ?? eventRow(events.reopenings, id);
    const load = snapshot.loads.find(row => row._id?.toString() === id);
    return { id, name: user?.name ?? evidence?.name ?? 'Usuário indisponível', role: user?.role ?? evidence?.role ?? 'desconhecido', active: user ? user.active !== false : false,
      highPriority: load?.highPriority ?? 0, assigned: load?.assigned ?? 0, inProgress: load?.inProgress ?? 0, pending: load?.pending ?? 0,
      resolutions: eventRow(events.resolutions, id)?.count ?? 0, participation: eventRow(events.participation, id)?.count ?? 0, reopenings: eventRow(events.reopenings, id)?.count ?? 0 };
  }).sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name, 'pt-BR'));
  // Quality: answers to the resolutions proved in the period (denominator), never the current assignee.
  const answerOf = new Map(answers.map((row) => [`${row._id.ticket}:${row._id.cycle}`, row]));
  const measured = events.resolvedCycles.map((row) => answerOf.get(`${row._id.ticket}:${row._id.cycle}`));
  const confirmed = measured.filter((row) => row?.confirmed).length;
  const contested = measured.filter((row) => row?.contested).length;
  const ratings = measured.flatMap((row) => (typeof row?.rating === 'number' ? [row.rating] : []));
  const quality = {
    resolutions: measured.length, confirmed, contested, awaiting: measured.length - confirmed - contested,
    responseRate: measured.length ? (confirmed + contested) / measured.length : null,
    ratings: ratings.length, averageRating: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
  };
  const periods = new Map<string, { period: string; created: number; resolved: number }>();
  for (const key of calendarKeys(range)) periods.set(key, { period: key, created: 0, resolved: 0 });
  for (const row of snapshot.trends) { const key = String(row._id); periods.set(key, { period: key, created: row.count, resolved: periods.get(key)?.resolved ?? 0 }); }
  for (const row of events.trends) { const key = String(row._id); const entry = periods.get(key) ?? { period: key, created: 0, resolved: 0 }; entry.resolved = row.count; periods.set(key, entry); }
  return {
    filters, range, asOf: now, demoControlsEnabled: env.DEMO_MODE && process.env.NODE_ENV !== 'production',
    alerts: { highUnassigned: count(snapshot.highUnassigned), oldPending: count(snapshot.oldPending), inactive: count(snapshot.inactive), unknownActivity: count(snapshot.unknownActivity), ageDays: filters.ageDays ?? 7, inactivityDays: filters.inactivityDays ?? 3, oldest: snapshot.oldest.map(row => ({ id: row._id.toString(), title: row.title, createdAt: row.createdAt, lastOperationalAt: row.lastOperationalAt ?? null, ageDays: Math.floor((now.getTime() - row.createdAt.getTime()) / 86400000) })) },
    workload: snapshot.loads.map(row => ({ id: row._id?.toString() ?? null, name: row._id ? userMap.get(row._id.toString())?.name ?? 'Usuário indisponível' : 'Não atribuído', pending: row.pending, alta: row.highPriority, media: row.mediumPriority, baixa: row.lowPriority })).sort((a, b) => b.pending - a.pending),
    current: { total: snapshot.states.reduce((sum, row) => sum + row.count, 0), inProgress: state('em_andamento'), backlog: state('aberto') + state('em_andamento'), unassigned: snapshot.loads.find(row => row._id === null)?.pending ?? 0 },
    period: { created: count(snapshot.created), resolutions: events.resolutions.reduce((sum, row) => sum + row.count, 0), resolvedTickets: count(events.uniqueTickets), reopenings: events.reopenings.reduce((sum, row) => sum + row.count, 0) },
    distributions: { priority: snapshot.priority, category: snapshot.category }, team, workloadBalance: assessWorkload(team),
    requesters: snapshot.requesters.map(row => ({ id: row._id.toString(), name: userMap.get(row._id.toString())?.name ?? 'Usuário indisponível', created: row.created, pending: row.pending, categories: row.categories })),
    options: { analysts: users.filter(u => ['ti', 'gestor'].includes(u.role)).map(u => ({ id: u._id.toString(), name: u.name })), requesters: users.map(u => ({ id: u._id.toString(), name: u.name })) },
    // Hour zeros are factual absence in the selected set; no synthetic historical events are introduced.
    trends: [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)), demand: { hours: Array.from({ length: 24 }, (_, hour) => ({ _id: hour, count: snapshot.hours.find(row => row._id === hour)?.count ?? 0 })), weekdays: snapshot.weekdays, categories: snapshot.createdCategories },
    quality,
    coverage: { resolvedWithoutStructuredHistory: Math.max(0, state('resolvido') - count(events.currentVerified)), conflictingResolutionCycles: count(events.conflicts) },
  };
}
