import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { TICKET_CATEGORIES, type TicketCategory } from './ticket.model';

export const ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const ARTICLE_LIMITS = {
  titleMin: 5,
  titleMax: 120,
  summaryMin: 10,
  summaryMax: 240,
  bodyMin: 30,
  bodyMax: 10000,
} as const;

/**
 * Help article. The body is plain text: blank lines separate paragraphs and lines starting with
 * "- " or "1. " form lists. It is never interpreted as HTML (see the frontend renderer).
 * Categories are the same ticket categories, so an article can be suggested for a ticket subject.
 */
export interface KnowledgeArticle {
  title: string;
  summary: string;
  category: TicketCategory;
  body: string;
  status: ArticleStatus;
  /** Title, summary and body without accents and in lowercase, used by the search. */
  searchText: string;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  publishedAt: Date | null;
  /** Optimistic lock for edits by two people at once. */
  revision: number;
  dataOrigin: 'operational' | 'demo';
  /** Stable key of demonstration articles, so the seed can run again without duplicates. */
  demoKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type KnowledgeArticleDocument = HydratedDocument<KnowledgeArticle>;

/** "Did this help?" One answer per person and article; answering again replaces it. */
export interface ArticleFeedback {
  article: Types.ObjectId;
  user: Types.ObjectId;
  helpful: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const articleSchema = new Schema<KnowledgeArticle>(
  {
    title: { type: String, required: true, trim: true, minlength: ARTICLE_LIMITS.titleMin, maxlength: ARTICLE_LIMITS.titleMax },
    summary: { type: String, required: true, trim: true, minlength: ARTICLE_LIMITS.summaryMin, maxlength: ARTICLE_LIMITS.summaryMax },
    category: { type: String, enum: TICKET_CATEGORIES, required: true },
    body: { type: String, required: true, trim: true, minlength: ARTICLE_LIMITS.bodyMin, maxlength: ARTICLE_LIMITS.bodyMax },
    status: { type: String, enum: ARTICLE_STATUSES, required: true, default: 'draft' },
    searchText: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedAt: { type: Date, default: null },
    revision: { type: Number, required: true, default: 1, min: 1 },
    dataOrigin: { type: String, enum: ['operational', 'demo'], required: true, default: 'operational' },
    demoKey: { type: String },
  },
  { timestamps: true },
);

// Public list and search: published articles of a category, most recently updated first.
articleSchema.index({ status: 1, category: 1, updatedAt: -1 });
articleSchema.index({ demoKey: 1 }, { unique: true, partialFilterExpression: { demoKey: { $type: 'string' } } });

const feedbackSchema = new Schema<ArticleFeedback>(
  {
    article: { type: Schema.Types.ObjectId, ref: 'KnowledgeArticle', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    helpful: { type: Boolean, required: true },
  },
  { timestamps: true },
);

// One answer per person: repeated clicks update the same document instead of adding votes.
feedbackSchema.index({ article: 1, user: 1 }, { unique: true });

export const KnowledgeArticleModel = model<KnowledgeArticle>('KnowledgeArticle', articleSchema);
export const ArticleFeedbackModel = model<ArticleFeedback>('ArticleFeedback', feedbackSchema);
