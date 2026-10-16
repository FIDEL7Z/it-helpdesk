import { env } from '../config/env';
import { HttpError } from '../errors/http-error';

/**
 * One policy for the origin of tickets and incidents, shared by every list and indicator.
 *
 * - operational: created by real accounts. The only origin outside the local demonstration mode.
 * - demo: created by the reserved fictitious accounts (seeds and presentations). A ticket is demo
 *   because of who created it, never because there is no operational data.
 * - legacy: older records without proven origin; kept as they are for traceability, never migrated.
 *
 * Demonstration and legacy data can only be consulted with DEMO_MODE=true outside production, and
 * only when asked for: no screen switches to them on its own.
 */
export type DataOrigin = 'operational' | 'demo' | 'legacy';

export const DATA_ORIGINS = ['operational', 'demo', 'legacy'] as const;

/** The reserved fictitious accounts created by the seeds; whatever they create is demonstration data. */
export const DEMO_EMAILS: ReadonlySet<string> = new Set(['ti@helpdesk.local', 'solicitante@helpdesk.local', 'gestor@helpdesk.local', 'demo.ti2@helpdesk.local', 'demo.solicitante2@helpdesk.local']);

export function demoDataEnabled(): boolean {
  return env.DEMO_MODE && process.env.NODE_ENV !== 'production';
}

/**
 * The origin a query may use. With demo data disabled, every query is operational and asking for
 * another origin is refused (403). With it enabled, the requested origin is used; none means all
 * origins, which the interface only sends when the person chooses "Todas" and labels each record.
 */
export function resolveOriginFilter(requested: DataOrigin | undefined): DataOrigin | undefined {
  if (demoDataEnabled()) return requested;
  if (requested && requested !== 'operational') throw new HttpError(403, 'Demonstration and legacy data are disabled');
  return 'operational';
}
