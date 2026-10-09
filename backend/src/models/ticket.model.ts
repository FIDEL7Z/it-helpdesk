import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const TICKET_CATEGORIES = ['hardware', 'software', 'rede', 'acesso', 'outros'] as const;
export const TICKET_PRIORITIES = ['baixa', 'media', 'alta'] as const;
export const TICKET_STATUSES = ['aberto', 'em_andamento', 'resolvido'] as const;
export const TICKET_EVENT_TYPES = ['created', 'updated', 'status_changed', 'reopened', 'assigned'] as const;

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

export interface TicketEvent {
  type: TicketEventType;
  author: Types.ObjectId;
  message: string;
  at: Date;
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
  createdAt: Date;
  updatedAt: Date;
}

export type TicketDocument = HydratedDocument<Ticket>;

const ticketEventSchema = new Schema<TicketEvent>(
  {
    type: { type: String, enum: TICKET_EVENT_TYPES, required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

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
  },
  { timestamps: true },
);

// Requesters list their own tickets; IT filters by status. Both sorted by newest first.
ticketSchema.index({ requester: 1, createdAt: -1 });
ticketSchema.index({ status: 1, createdAt: -1 });

export const TicketModel = model<Ticket>('Ticket', ticketSchema);
