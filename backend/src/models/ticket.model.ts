import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const TICKET_CATEGORIES = ['hardware', 'software', 'rede', 'acesso', 'outros'] as const;
export const TICKET_PRIORITIES = ['baixa', 'media', 'alta'] as const;
export const TICKET_STATUSES = ['aberto', 'em_andamento', 'resolvido'] as const;
// resolution_confirmed / resolution_rated: the requester's answer to a resolution, in the same audited history.
export const TICKET_EVENT_TYPES = ['created', 'updated', 'status_changed', 'reopened', 'assigned', 'resolved', 'resolution_confirmed', 'resolution_rated'] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

/** Allowed status changes. "resolvido" -> "em_andamento" is the reopen flow. */
export const STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  aberto: ['em_andamento'],
  em_andamento: ['resolvido'],
  resolvido: ['em_andamento'],
};

export const TICKET_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  descriptionMin: 10,
  descriptionMax: 5000,
} as const;

export interface AuditEvent {
  eventId: string;
  operationId: string;
  schemaVersion: number;
  actorId: Types.ObjectId;
  actorSnapshot: { name: string; role: string };
  eventType: TicketEventType;
  occurredAt: Date;
  revision: number;
  eventIndex: number;
  cycleId: number;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
  assigneeAtEvent: Types.ObjectId | null;
  assigneeSnapshot?: { id: string; name: string; role: string } | null;
  reason?: string;
  dataOrigin: 'operational' | 'demo' | 'legacy';
}

export interface TicketEvent {
  audit?: AuditEvent;
  type: TicketEventType;
  author?: Types.ObjectId;
  message: string;
  at?: Date;
}

/**
 * What the requester answered in the guided form, kept apart from the description they wrote.
 * category: the subject chosen when asking (the team may correct the ticket category later).
 * question: the text as it was asked, so old answers stay readable if the catalog changes.
 */
export interface TicketIntake {
  category: TicketCategory;
  answers: { key: string; question: string; answer: string }[];
  /** Help article the person read before asking, if they came from "Ainda preciso de ajuda". */
  article: { id: Types.ObjectId; title: string } | null;
}

export interface Ticket {
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  requester: Types.ObjectId;
  assignee: Types.ObjectId | null;
  history: TicketEvent[];
  revision: number;
  activeCycleId: number;
  resolvedAt: Date | null;
  resolvedBy: Types.ObjectId | null;
  dataOrigin: 'operational' | 'demo' | 'legacy';
  /** Absent on tickets opened before the guided form or without answers. */
  intake?: TicketIntake | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TicketDocument = HydratedDocument<Ticket>;

const auditSchema = new Schema<AuditEvent>({
  eventId: { type: String, required: true },
  operationId: { type: String, required: true },
  schemaVersion: { type: Number, required: true, enum: [2] },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  actorSnapshot: { name: { type: String, required: true }, role: { type: String, required: true } },
  eventType: { type: String, enum: TICKET_EVENT_TYPES, required: true },
  occurredAt: { type: Date, required: true },
  revision: { type: Number, required: true, min: 0, validate: Number.isInteger },
  eventIndex: { type: Number, required: true, min: 0, validate: Number.isInteger },
  cycleId: { type: Number, required: true, min: 1, validate: Number.isInteger },
  from: { type: Schema.Types.Mixed, required: true },
  to: { type: Schema.Types.Mixed, required: true },
  assigneeAtEvent: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  assigneeSnapshot: { type: new Schema({ id: String, name: String, role: String }, { _id: false }), default: null },
  reason: { type: String, maxlength: 1000 },
  dataOrigin: { type: String, enum: ['operational', 'demo', 'legacy'], required: true },
}, { _id: false, minimize: false });

const ticketEventSchema = new Schema<TicketEvent>(
  {
    audit: { type: auditSchema, required: false },
    type: { type: String, enum: TICKET_EVENT_TYPES, required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    message: { type: String, required: true },
    at: { type: Date, required: false },
  },
  { _id: false },
);

ticketEventSchema.pre('validate', function () {
  if (!this.audit) return; // Legacy events are preserved without invented metadata.
  if (!this.author || !this.author.equals(this.audit.actorId)) this.invalidate('audit.actorId', 'Actor must match authenticated event author');
  if (!this.at || this.at.getTime() !== this.audit.occurredAt.getTime() || this.at.getTime() > Date.now()) {
    this.invalidate('audit.occurredAt', 'Audit date must match event date and cannot be in the future');
  }
  if (this.type !== this.audit.eventType) this.invalidate('audit.eventType', 'Event types must agree');
});

const intakeSchema = new Schema<TicketIntake>({
  category: { type: String, enum: TICKET_CATEGORIES, required: true },
  answers: {
    type: [new Schema({ key: { type: String, required: true }, question: { type: String, required: true }, answer: { type: String, required: true, maxlength: 200 } }, { _id: false })],
    default: [],
  },
  article: { type: new Schema({ id: { type: Schema.Types.ObjectId, ref: 'KnowledgeArticle', required: true }, title: { type: String, required: true } }, { _id: false }), default: null },
}, { _id: false });

const ticketSchema = new Schema<Ticket>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: TICKET_LIMITS.titleMin,
      maxlength: TICKET_LIMITS.titleMax,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      minlength: TICKET_LIMITS.descriptionMin,
      maxlength: TICKET_LIMITS.descriptionMax,
    },
    category: { type: String, enum: TICKET_CATEGORIES, required: true },
    priority: { type: String, enum: TICKET_PRIORITIES, required: true, default: 'media' },
    status: { type: String, enum: TICKET_STATUSES, required: true, default: 'aberto' },
    requester: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignee: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Written only by the backend services, never from request bodies.
    history: { type: [ticketEventSchema], default: [] },
    revision: { type: Number, default: 0, min: 0 },
    activeCycleId: { type: Number, default: 1, min: 1 },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    dataOrigin: { type: String, enum: ['operational', 'demo', 'legacy'], default: 'legacy' },
    intake: { type: intakeSchema, default: undefined },
  },
  { timestamps: true },
);

// Requesters list their own tickets; IT filters by status. Both sorted by newest first.
ticketSchema.index({ requester: 1, createdAt: -1 });
ticketSchema.index({ status: 1, createdAt: -1 });
// Management reads separate origins before aggregating creation and current load.
ticketSchema.index({ dataOrigin: 1, createdAt: -1 });
ticketSchema.index({ dataOrigin: 1, assignee: 1, status: 1 });

export const TicketModel = model<Ticket>('Ticket', ticketSchema);
