import { randomUUID } from 'node:crypto';
import type { PublicUser } from '../../models/user.model';

/*
 * Short conversation memory for follow-up questions ("e se continuar assim?"). It lives only in
 * this process's memory: it is never stored in the database and is gone after a restart. The
 * client sends just a conversation id; the turns stay here, so nobody can send fake assistant or
 * system messages. The key includes the person's id, so an id never opens someone else's
 * conversation, and a role change starts a new one.
 */

export interface Turn {
  role: 'user' | 'model';
  text: string;
}

export const CONVERSATION_LIMITS = Object.freeze({
  /** Messages kept (6 questions and their answers). */
  maxTurns: 12,
  maxTurnChars: 2_000,
  idleMs: 30 * 60_000,
  maxConversations: 1_000,
});

interface Conversation {
  role: PublicUser['role'];
  turns: Turn[];
  touchedAt: number;
}

const conversations = new Map<string, Conversation>();
let clock = () => Date.now();
const keyOf = (actor: PublicUser, id: string) => `${actor.id}:${id}`;

function sweep(now: number): void {
  for (const [key, conversation] of conversations) {
    if (now - conversation.touchedAt > CONVERSATION_LIMITS.idleMs) conversations.delete(key);
  }
}

/** The person's conversation with this id, or a new one (unknown, expired or someone else's id). */
export function openConversation(actor: PublicUser, requestedId?: string): { id: string; turns: Turn[] } {
  const now = clock();
  sweep(now);
  const existing = requestedId ? conversations.get(keyOf(actor, requestedId)) : undefined;
  if (requestedId && existing && existing.role === actor.role) {
    existing.touchedAt = now;
    return { id: requestedId, turns: [...existing.turns] };
  }
  return { id: randomUUID(), turns: [] };
}

/** Keeps a question and its answer; the oldest messages drop out first. */
export function remember(actor: PublicUser, id: string, question: string, answer: string): void {
  const key = keyOf(actor, id);
  const conversation = conversations.get(key) ?? { role: actor.role, turns: [], touchedAt: clock() };
  conversation.turns.push(
    { role: 'user', text: question.slice(0, CONVERSATION_LIMITS.maxTurnChars) },
    { role: 'model', text: answer.slice(0, CONVERSATION_LIMITS.maxTurnChars) },
  );
  conversation.turns = conversation.turns.slice(-CONVERSATION_LIMITS.maxTurns);
  conversation.touchedAt = clock();
  conversations.delete(key);
  conversations.set(key, conversation);
  if (conversations.size > CONVERSATION_LIMITS.maxConversations) conversations.delete(conversations.keys().next().value!);
}

/** Tests: start from no conversations, and optionally move the clock. */
export function forgetConversationsForTests(): void {
  conversations.clear();
  clock = () => Date.now();
}
export function setConversationClockForTests(next: () => number): void {
  clock = next;
}
