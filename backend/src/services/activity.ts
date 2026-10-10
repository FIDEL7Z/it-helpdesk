/** Only consistent structured actions performed by support/management prove activity. */
export function lastOperationalActivity(now: Date): Record<string, unknown> {
  return { $max: { $map: {
    input: { $filter: { input: { $ifNull: ['$history', []] }, as: 'event', cond: { $and: [
      { $eq: ['$$event.audit.schemaVersion', 2] },
      { $eq: [{ $type: '$$event.audit.eventId' }, 'string'] },
      { $ne: ['$$event.audit.eventId', ''] },
      { $gte: ['$$event.audit.cycleId', 1] },
      { $eq: [{ $type: '$$event.audit.actorId' }, 'objectId'] },
      { $in: ['$$event.audit.actorSnapshot.role', ['ti', 'gestor']] },
      { $in: ['$$event.audit.eventType', ['updated', 'assigned', 'status_changed', 'resolved', 'reopened']] },
      { $eq: ['$$event.author', '$$event.audit.actorId'] },
      { $eq: ['$$event.type', '$$event.audit.eventType'] },
      { $eq: ['$$event.at', '$$event.audit.occurredAt'] },
      { $eq: [{ $type: '$$event.audit.occurredAt' }, 'date'] },
      { $lte: ['$$event.audit.occurredAt', now] },
      { $eq: ['$$event.audit.dataOrigin', { $ifNull: ['$dataOrigin', 'legacy'] }] },
    ] } } }, as: 'event', in: '$$event.audit.occurredAt',
  } } };
}

export const daysAgo = (days: number, now: Date) => new Date(now.getTime() - days * 86400000);
