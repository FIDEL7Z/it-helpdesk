import { Types, type QueryFilter } from 'mongoose';
import { can } from '../auth/permissions';
import { HttpError } from '../errors/http-error';
import {
  ArticleFeedbackModel,
  KnowledgeArticleModel,
  type ArticleStatus,
  type KnowledgeArticle,
  type KnowledgeArticleDocument,
} from '../models/article.model';
import type { TicketCategory } from '../models/ticket.model';
import { UserModel, type PublicUser } from '../models/user.model';

// ---------- Response shapes ----------

/** What every authenticated user reads. Nobody's vote or identity is included. */
export interface ArticleView {
  id: string;
  title: string;
  summary: string;
  category: TicketCategory;
  body?: string;
  updatedAt: Date;
  /** The reader's own answer to "did this help?", or null. */
  myFeedback?: boolean | null;
}

/** Team view (kb:manage): status, authorship and the vote totals. */
export interface ManagedArticleView extends ArticleView {
  status: ArticleStatus;
  revision: number;
  createdBy: { id: string; name: string } | null;
  updatedBy: { id: string; name: string } | null;
  publishedAt: Date | null;
  createdAt: Date;
  dataOrigin: KnowledgeArticle['dataOrigin'];
  helpfulCount: number;
  notHelpfulCount: number;
}

export interface ArticleInput {
  title: string;
  summary: string;
  category: TicketCategory;
  body: string;
  status: ArticleStatus;
}

export interface ArticleSearch {
  q?: string;
  category?: TicketCategory;
  status?: ArticleStatus;
  page: number;
  limit: number;
}

// ---------- Helpers ----------

/** Lowercase without accents: "Conexão" and "conexao" find the same article. */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchTextOf(input: Pick<ArticleInput, 'title' | 'summary' | 'body'>): string {
  return normalizeForSearch(`${input.title}\n${input.summary}\n${input.body}`);
}

/** Every word must appear (in title, summary or body), in any order. Up to 8 words are used. */
function searchFilter(q: string | undefined): QueryFilter<KnowledgeArticle> {
  const words = normalizeForSearch(q ?? '').split(/\s+/).filter((word) => word.length > 0).slice(0, 8);
  return words.length === 0 ? {} : { $and: words.map((word) => ({ searchText: { $regex: escapeRegex(word) } })) };
}

function toView(article: KnowledgeArticleDocument, withBody: boolean, myFeedback?: boolean | null): ArticleView {
  return {
    id: article.id,
    title: article.title,
    summary: article.summary,
    category: article.category,
    ...(withBody && { body: article.body }),
    updatedAt: article.updatedAt,
    ...(myFeedback !== undefined && { myFeedback }),
  };
}

async function feedbackTotals(ids: Types.ObjectId[]): Promise<Map<string, { helpful: number; notHelpful: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await ArticleFeedbackModel.aggregate<{ _id: Types.ObjectId; helpful: number; notHelpful: number }>([
    { $match: { article: { $in: ids } } },
    { $group: { _id: '$article', helpful: { $sum: { $cond: ['$helpful', 1, 0] } }, notHelpful: { $sum: { $cond: ['$helpful', 0, 1] } } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), { helpful: row.helpful, notHelpful: row.notHelpful }]));
}

async function toManaged(articles: KnowledgeArticleDocument[], withBody: boolean): Promise<ManagedArticleView[]> {
  const [totals, users] = await Promise.all([
    feedbackTotals(articles.map((article) => article._id)),
    UserModel.find({ _id: { $in: articles.flatMap((article) => [article.createdBy, article.updatedBy]) } }).select('name'),
  ]);
  const names = new Map(users.map((user) => [user.id, { id: user.id, name: user.name }]));
  return articles.map((article) => ({
    ...toView(article, withBody),
    status: article.status,
    revision: article.revision,
    createdBy: names.get(article.createdBy.toString()) ?? null,
    updatedBy: names.get(article.updatedBy.toString()) ?? null,
    publishedAt: article.publishedAt,
    createdAt: article.createdAt,
    dataOrigin: article.dataOrigin,
    helpfulCount: totals.get(article.id)?.helpful ?? 0,
    notHelpfulCount: totals.get(article.id)?.notHelpful ?? 0,
  }));
}

async function findArticle(id: string): Promise<KnowledgeArticleDocument> {
  const article = await KnowledgeArticleModel.findById(id);
  if (!article) throw new HttpError(404, 'Article not found');
  return article;
}

/** Drafts and archived articles do not exist for readers (404, as for other people's tickets). */
async function findReadable(id: string, actor: PublicUser): Promise<KnowledgeArticleDocument> {
  const article = await findArticle(id);
  if (article.status !== 'published' && !can(actor.role, 'kb:manage')) throw new HttpError(404, 'Article not found');
  return article;
}

// ---------- Readers (any authenticated user) ----------

/** Published articles only, whoever asks. Summaries, without the body. */
export async function searchPublished(query: Omit<ArticleSearch, 'status'>): Promise<{ articles: ArticleView[]; total: number }> {
  const filter: QueryFilter<KnowledgeArticle> = {
    status: 'published',
    ...(query.category && { category: query.category }),
    ...searchFilter(query.q),
  };
  const [total, articles] = await Promise.all([
    KnowledgeArticleModel.countDocuments(filter),
    KnowledgeArticleModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit),
  ]);
  return { articles: articles.map((article) => toView(article, false)), total };
}

export async function getArticle(id: string, actor: PublicUser): Promise<ArticleView | ManagedArticleView> {
  const article = await findReadable(id, actor);
  const mine = await ArticleFeedbackModel.findOne({ article: article._id, user: new Types.ObjectId(actor.id) }).select('helpful');
  if (can(actor.role, 'kb:manage')) {
    const [managed] = await toManaged([article], true);
    return { ...managed, myFeedback: mine?.helpful ?? null };
  }
  return toView(article, true, mine?.helpful ?? null);
}

/**
 * "Did this help?" Only for published articles. One answer per person: answering again replaces
 * the previous answer, so repeated clicks never add votes. The user comes from the token.
 */
export async function giveFeedback(id: string, helpful: boolean, actor: PublicUser): Promise<{ myFeedback: boolean }> {
  const article = await findArticle(id);
  if (article.status !== 'published') throw new HttpError(404, 'Article not found');
  const key = { article: article._id, user: new Types.ObjectId(actor.id) };
  try {
    await ArticleFeedbackModel.updateOne(key, { $set: { helpful } }, { upsert: true });
  } catch (error) {
    // Two simultaneous first answers race on the unique index; the row exists either way.
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
    await ArticleFeedbackModel.updateOne(key, { $set: { helpful } });
  }
  return { myFeedback: helpful };
}

// ---------- Team (kb:manage, enforced by the routes) ----------

export async function searchManaged(query: ArticleSearch): Promise<{ articles: ManagedArticleView[]; total: number }> {
  const filter: QueryFilter<KnowledgeArticle> = {
    ...(query.status && { status: query.status }),
    ...(query.category && { category: query.category }),
    ...searchFilter(query.q),
  };
  const [total, articles] = await Promise.all([
    KnowledgeArticleModel.countDocuments(filter),
    KnowledgeArticleModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit),
  ]);
  return { articles: await toManaged(articles, false), total };
}

export async function createArticle(input: ArticleInput, actor: PublicUser): Promise<ManagedArticleView> {
  const authorId = new Types.ObjectId(actor.id);
  const article = await KnowledgeArticleModel.create({
    ...input,
    searchText: searchTextOf(input),
    createdBy: authorId,
    updatedBy: authorId,
    publishedAt: input.status === 'published' ? new Date() : null,
    revision: 1,
    dataOrigin: 'operational',
  });
  const [managed] = await toManaged([article], true);
  return managed;
}

/** Edit text, category or status. A stale revision (someone else saved first) returns 409. */
export async function updateArticle(id: string, input: Partial<ArticleInput>, expectedRevision: number,
  actor: PublicUser): Promise<ManagedArticleView> {
  const article = await findArticle(id);
  if (article.revision !== expectedRevision) throw new HttpError(409, 'Article was changed by someone else. Reload and try again');

  // Same values as before: nothing to save (as with tickets, no revision is spent).
  if ((Object.keys(input) as (keyof ArticleInput)[]).every((key) => input[key] === article[key])) {
    const [unchanged] = await toManaged([article], true);
    return unchanged;
  }
  const next = { title: article.title, summary: article.summary, body: article.body, ...input };
  const changes: Partial<KnowledgeArticle> = { ...input, searchText: searchTextOf(next), updatedBy: new Types.ObjectId(actor.id) };
  // The first publication keeps its date; archiving or returning to draft does not erase it.
  if (input.status === 'published' && !article.publishedAt) changes.publishedAt = new Date();

  const updated = await KnowledgeArticleModel.findOneAndUpdate(
    { _id: article._id, revision: expectedRevision },
    { $set: changes, $inc: { revision: 1 } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) throw new HttpError(409, 'Article was changed by someone else. Reload and try again');
  const [managed] = await toManaged([updated], true);
  return managed;
}
