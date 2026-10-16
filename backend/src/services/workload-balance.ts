/**
 * "Carga desigual": an operational hint to redistribute current work, never a performance measure.
 *
 * Population (the operational scale): active IT analysts, including those with zero pending tickets,
 * because an available analyst without assignments is part of the imbalance. Managers join only while
 * they hold pending tickets (acting in the operation); a manager outside the scale does not dilute the
 * average. Inactive or removed accounts are left out of the comparison (their tickets still show in the
 * team table). Load = current pending tickets (open + in progress) assigned to the person, under the
 * page filters; unassigned tickets have their own alert.
 *
 * Alert: at least two people in the scale and a gap between the most and the least loaded of at least
 * MIN_GAP tickets and at least RELATIVE_GAP of the average. Small or proportional differences
 * (16 and 14, 4 and 3) are normal variation, not an imbalance.
 */

export const WORKLOAD_MIN_GAP = 3;
export const WORKLOAD_RELATIVE_GAP = 0.5;

export interface WorkloadMember { id: string; name: string; role: string; active: boolean; pending: number }

export interface WorkloadBalance {
  members: number;
  average: number;
  highest: { names: string[]; ids: string[]; pending: number } | null;
  lowest: { names: string[]; pending: number } | null;
  gap: number;
  uneven: boolean;
}

export function assessWorkload(team: WorkloadMember[]): WorkloadBalance {
  const scale = team.filter((row) => row.active && (row.role === 'ti' || (row.role === 'gestor' && row.pending > 0)));
  if (scale.length === 0) return { members: 0, average: 0, highest: null, lowest: null, gap: 0, uneven: false };
  const loads = scale.map((row) => row.pending);
  const max = Math.max(...loads);
  const min = Math.min(...loads);
  const average = loads.reduce((sum, value) => sum + value, 0) / scale.length;
  const gap = max - min;
  const uneven = scale.length >= 2 && gap >= WORKLOAD_MIN_GAP && gap >= WORKLOAD_RELATIVE_GAP * average;
  const at = (value: number) => scale.filter((row) => row.pending === value);
  return {
    members: scale.length,
    average,
    highest: { names: at(max).map((row) => row.name), ids: at(max).map((row) => row.id), pending: max },
    lowest: { names: at(min).map((row) => row.name), pending: min },
    gap,
    uneven,
  };
}
