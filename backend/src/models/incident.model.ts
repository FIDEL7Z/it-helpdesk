import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * A shared incident is the public face of one ticket ("main ticket") that affects many people.
 * It lives in its own collection so that:
 * - people joining it never touch the ticket document (no revision conflicts with the analyst);
 * - the public data never shares a document with the private ticket description;
 * - the ticket audit is not filled with one event per person who clicks "me too".
 */
export const INCIDENT_STATUSES = ['active', 'closed'] as const;
export const INCIDENT_EVENT_TYPES = ['published', 'updated', 'closed', 'republished'] as const;
export const INCIDENT_CLOSE_REASONS = ['ticket_resolved', 'manual'] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];
export type IncidentCloseReason = (typeof INCIDENT_CLOSE_REASONS)[number];

export const INCIDENT_LIMITS = {
  titleMin: 5,
  titleMax: 120,
  messageMin: 10,
  messageMax: 600,
} as const;

export interface IncidentEvent {
  type: IncidentEventType;
  actorId: Types.ObjectId;
  /** Name and role at the moment of the action, kept even if the user changes later. */
  actorSnapshot: { name: string; role: string };
  at: Date;
  /** Incident revision produced by this event. */
  revision: number;
  /** Publication cycle the event belongs to (a republication starts a new cycle). */
  cycle: number;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

export interface SharedIncident {
  ticket: Types.ObjectId;
  title: string;
  publicMessage: string;
  status: IncidentStatus;
  /** Starts at 1; a republication after closing starts a new cycle with new participations. */
  cycle: number;
  publishedBy: Types.ObjectId;
  publishedAt: Date;
  closedBy: Types.ObjectId | null;
  closedAt: Date | null;
  closeReason: IncidentCloseReason | null;
  /** Public text shown to the people who followed the incident after it is closed. */
  resolutionMessage: string | null;
  /** Optimistic lock for edits by the team (participations do not change it). */
  revision: number;
  history: IncidentEvent[];
  dataOrigin: 'operational' | 'demo' | 'legacy';
  createdAt: Date;
  updatedAt: Date;
}

export type SharedIncidentDocument = HydratedDocument<SharedIncident>;

export interface IncidentParticipation {
  incident: Types.ObjectId;
  cycle: number;
  user: Types.ObjectId;
  joinedAt: Date;
  /** Set when the person says the problem no longer affects them. Joining again clears it. */
  leftAt: Date | null;
}

const incidentEventSchema = new Schema<IncidentEvent>(
  {
    type: { type: String, enum: INCIDENT_EVENT_TYPES, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorSnapshot: { name: { type: String, required: true }, role: { type: String, required: true } },
    at: { type: Date, required: true },
    revision: { type: Number, required: true, min: 1 },
    cycle: { type: Number, required: true, min: 1 },
    from: { type: Schema.Types.Mixed, required: true },
    to: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false, minimize: false },
);

const sharedIncidentSchema = new Schema<SharedIncident>(
  {
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true },
    title: { type: String, required: true, trim: true, minlength: INCIDENT_LIMITS.titleMin, maxlength: INCIDENT_LIMITS.titleMax },
    publicMessage: { type: String, required: true, trim: true, minlength: INCIDENT_LIMITS.messageMin, maxlength: INCIDENT_LIMITS.messageMax },
    status: { type: String, enum: INCIDENT_STATUSES, required: true, default: 'active' },
    cycle: { type: Number, required: true, default: 1, min: 1 },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedAt: { type: Date, required: true },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, enum: [...INCIDENT_CLOSE_REASONS, null], default: null },
    resolutionMessage: { type: String, trim: true, maxlength: INCIDENT_LIMITS.messageMax, default: null },
    revision: { type: Number, required: true, default: 1, min: 1 },
    history: { type: [incidentEventSchema], default: [] },
    dataOrigin: { type: String, enum: ['operational', 'demo', 'legacy'], required: true, default: 'operational' },
  },
  { timestamps: true },
);

// One shared incident per ticket: publishing twice for the same ticket is a conflict, not a duplicate.
sharedIncidentSchema.index({ ticket: 1 }, { unique: true });
sharedIncidentSchema.index({ status: 1, publishedAt: -1 });

const participationSchema = new Schema<IncidentParticipation>(
  {
    incident: { type: Schema.Types.ObjectId, ref: 'SharedIncident', required: true },
    cycle: { type: Number, required: true, min: 1 },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    joinedAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
  },
  { timestamps: false },
);

// Idempotency guaranteed by the database: one row per person, per incident and publication cycle.
participationSchema.index({ incident: 1, cycle: 1, user: 1 }, { unique: true });
participationSchema.index({ user: 1, leftAt: 1 });

export const SharedIncidentModel = model<SharedIncident>('SharedIncident', sharedIncidentSchema);
export const IncidentParticipationModel = model<IncidentParticipation>('IncidentParticipation', participationSchema);
