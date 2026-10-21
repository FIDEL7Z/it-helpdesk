import { z } from 'zod';
import { env } from '../../config/env';
import { periodRange } from '../manager.service';

/*
 * Periods the assistant may ask about, always resolved here in the application time zone
 * (APP_TIMEZONE) into an explicit [start, end) window with a readable label. The model only picks
 * a name or two calendar dates; it never sends instants, operators or filters.
 */

export const PERIOD_NAMES = ['hoje', 'ontem', 'ultimos_7_dias', '7_dias_anteriores', 'este_mes', 'mes_passado', 'este_ano'] as const;
export type PeriodName = (typeof PERIOD_NAMES)[number];

export interface ResolvedPeriod {
  start: Date;
  end: Date;
  /** For people: "13/10/2026 a 19/10/2026 (até agora)". */
  label: string;
  timezone: string;
}

const MAX_DAYS = 366;
const DAY = 86_400_000;

/** Local midnight of the day that contains `instant` (daylight saving time included). */
export function startOfLocalDay(instant: Date, timezone = env.APP_TIMEZONE): Date {
  return periodRange('today', instant, timezone).start;
}
/** Local midnight `days` calendar days away from the local day that contains `instant`. */
function shiftDays(dayStart: Date, days: number, timezone: string): Date {
  // Noon of the target day, then back to its midnight: safe across daylight saving changes.
  return startOfLocalDay(new Date(dayStart.getTime() + days * DAY + DAY / 2), timezone);
}

function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(instant);
}

function labelOf(start: Date, end: Date, now: Date, timezone: string): string {
  const open = end.getTime() >= now.getTime();
  const last = open ? now : new Date(end.getTime() - 1);
  const first = localDate(start, timezone);
  const final = localDate(last, timezone);
  const span = first === final ? first : `${first} a ${final}`;
  return open ? `${span} (até agora)` : span;
}

export function resolveNamedPeriod(name: PeriodName, now = new Date(), timezone = env.APP_TIMEZONE): ResolvedPeriod {
  const today = startOfLocalDay(now, timezone);
  const monthStart = periodRange('month', now, timezone).start;
  let start: Date;
  let end: Date = now;
  switch (name) {
    case 'hoje': start = today; break;
    case 'ontem': start = shiftDays(today, -1, timezone); end = today; break;
    case 'ultimos_7_dias': start = shiftDays(today, -6, timezone); break;
    case '7_dias_anteriores': start = shiftDays(today, -13, timezone); end = shiftDays(today, -6, timezone); break;
    case 'este_mes': start = monthStart; break;
    case 'mes_passado': start = periodRange('month', new Date(monthStart.getTime() - DAY / 2), timezone).start; end = monthStart; break;
    case 'este_ano': start = periodRange('year', now, timezone).start; break;
  }
  return { start, end, label: labelOf(start, end, now, timezone), timezone };
}

/** Two calendar dates (inclusive), at most a year apart and not after today. */
export function resolveDates(from: string, to: string, now = new Date(), timezone = env.APP_TIMEZONE): ResolvedPeriod | { error: string } {
  const parse = (text: string) => {
    const [year, month, day] = text.split('-').map(Number);
    const noon = new Date(Date.UTC(year, month - 1, day, 12));
    return noon.getUTCDate() === day ? startOfLocalDay(noon, timezone) : null;
  };
  const first = parse(from);
  const last = parse(to);
  if (!first || !last) return { error: 'Data inválida.' };
  if (last < first) return { error: 'A data final vem antes da inicial.' };
  if (first > now) return { error: 'O período começa no futuro.' };
  const end = new Date(Math.min(shiftDays(last, 1, timezone).getTime(), now.getTime()));
  if (end.getTime() - first.getTime() > MAX_DAYS * DAY) return { error: `O período pode ter no máximo ${MAX_DAYS} dias.` };
  return { start: first, end, label: labelOf(first, end, now, timezone), timezone };
}

/** The period arguments every analytic tool accepts: a name, or two dates. */
export const periodArgs = {
  periodo: z.enum(PERIOD_NAMES).optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};
export const PERIOD_SCHEMA = {
  periodo: { type: 'string', enum: [...PERIOD_NAMES], description: 'Período nomeado. Use ultimos_7_dias para "esta semana" e 7_dias_anteriores para "semana passada".' },
  de: { type: 'string', description: 'Data inicial AAAA-MM-DD (use com "ate", em vez de "periodo").' },
  ate: { type: 'string', description: 'Data final AAAA-MM-DD, inclusive.' },
};

/** The window for a tool call: dates when both are given, otherwise the name (or the fallback). */
export function periodFrom(args: { periodo?: PeriodName; de?: string; ate?: string }, fallback: PeriodName, now = new Date()): ResolvedPeriod | { error: string } {
  if (args.de || args.ate) {
    if (!args.de || !args.ate) return { error: 'Informe as duas datas, "de" e "ate".' };
    return resolveDates(args.de, args.ate, now);
  }
  return resolveNamedPeriod(args.periodo ?? fallback, now);
}

/** Change from `before` to `after`: absolute always, percent only when `before` is not zero. */
export function variation(before: number, after: number): { anterior: number; atual: number; diferenca: number; percentual: number | null } {
  return { anterior: before, atual: after, diferenca: after - before, percentual: before === 0 ? null : Math.round(((after - before) / before) * 1000) / 10 };
}
