import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { ARTICLE_LIMITS, ARTICLE_STATUSES } from '../models/article.model';
import { TICKET_CATEGORIES } from '../models/ticket.model';
import * as articleService from '../services/article.service';

export const MAX_ARTICLES_PAGE = 20;

const idParamsSchema = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid article id') });

const searchSchema = z.object({
  q: z.string().trim().max(100).optional().transform((value) => value || undefined),
  category: z.enum(TICKET_CATEGORIES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_ARTICLES_PAGE).default(10),
});

const manageSearchSchema = searchSchema.extend({ status: z.enum(ARTICLE_STATUSES).optional() });

const fields = {
  title: z.string().trim().min(ARTICLE_LIMITS.titleMin).max(ARTICLE_LIMITS.titleMax),
  summary: z.string().trim().min(ARTICLE_LIMITS.summaryMin).max(ARTICLE_LIMITS.summaryMax),
  category: z.enum(TICKET_CATEGORIES),
  body: z.string().trim().min(ARTICLE_LIMITS.bodyMin).max(ARTICLE_LIMITS.bodyMax),
  status: z.enum(ARTICLE_STATUSES),
};

// strictObject: author, editor, dates and counters come from the server, never from the body.
const createSchema = z.strictObject({ ...fields, status: fields.status.default('draft') });

const updateSchema = z
  .strictObject({
    title: fields.title.optional(),
    summary: fields.summary.optional(),
    category: fields.category.optional(),
    body: fields.body.optional(),
    status: fields.status.optional(),
    expectedRevision: z.number().int().min(1),
  })
  .refine((input) => ['title', 'summary', 'category', 'body', 'status'].some((key) => input[key as keyof typeof input] !== undefined), {
    message: 'Provide at least one field to update',
  });

const feedbackSchema = z.strictObject({ helpful: z.boolean() });

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

export async function search(req: Request, res: Response): Promise<void> {
  const query = searchSchema.parse(req.query);
  const { articles, total } = await articleService.searchPublished(query);
  res.json({ articles, pagination: pagination(query.page, query.limit, total) });
}

export async function getArticle(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  res.json({ article: await articleService.getArticle(id, getAuthenticatedUser(req)) });
}

export async function giveFeedback(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { helpful } = feedbackSchema.parse(req.body);
  res.json(await articleService.giveFeedback(id, helpful, getAuthenticatedUser(req)));
}

export async function searchManaged(req: Request, res: Response): Promise<void> {
  const query = manageSearchSchema.parse(req.query);
  const { articles, total } = await articleService.searchManaged(query);
  res.json({ articles, pagination: pagination(query.page, query.limit, total) });
}

export async function createArticle(req: Request, res: Response): Promise<void> {
  const input = createSchema.parse(req.body);
  res.status(201).json({ article: await articleService.createArticle(input, getAuthenticatedUser(req)) });
}

export async function updateArticle(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { expectedRevision, ...input } = updateSchema.parse(req.body);
  res.json({ article: await articleService.updateArticle(id, input, expectedRevision, getAuthenticatedUser(req)) });
}
