import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessWorkload, type WorkloadMember } from '../src/services/workload-balance';

// "Carga desigual": who is compared and which difference deserves an alert.
const member = (name: string, pending: number, role = 'ti', active = true): WorkloadMember => ({ id: name.toLowerCase(), name, role, active, pending });

describe('workload balance', () => {
  it('does not flag two analysts with 16 and 14 tickets, and a manager outside the scale does not dilute the average', () => {
    const result = assessWorkload([member('Carlos', 16), member('João', 14), member('Ana', 0, 'gestor')]);
    assert.equal(result.members, 2);
    assert.equal(result.average, 15);
    assert.equal(result.gap, 2);
    assert.equal(result.uneven, false);
  });

  it('flags clearly different loads and names the busiest and the least loaded', () => {
    const result = assessWorkload([member('Carlos', 20), member('João', 10)]);
    assert.equal(result.uneven, true);
    assert.deepEqual(result.highest, { names: ['Carlos'], ids: ['carlos'], pending: 20 });
    assert.deepEqual(result.lowest, { names: ['João'], pending: 10 });
  });

  it('keeps an available analyst with zero tickets in the comparison', () => {
    const result = assessWorkload([member('Carlos', 3), member('João', 0)]);
    assert.equal(result.members, 2);
    assert.equal(result.uneven, true);
  });

  it('treats small absolute differences as normal variation', () => {
    assert.equal(assessWorkload([member('Carlos', 4), member('João', 3)]).uneven, false);
    assert.equal(assessWorkload([member('Carlos', 2), member('João', 0)]).uneven, false, 'a gap below 3 tickets is not an imbalance');
    assert.equal(assessWorkload([member('Carlos', 30), member('João', 25)]).uneven, false, 'a gap below half the average is proportional');
  });

  it('includes a manager while they hold pending tickets', () => {
    const result = assessWorkload([member('Carlos', 8), member('Ana', 1, 'gestor')]);
    assert.equal(result.members, 2);
    assert.equal(result.uneven, true);
  });

  it('leaves inactive accounts and other roles out of the comparison', () => {
    const result = assessWorkload([member('Carlos', 9), member('Saiu', 0, 'ti', false), member('Histórico', 0, 'desconhecido', false), member('Mariana', 0, 'solicitante')]);
    assert.equal(result.members, 1);
    assert.equal(result.uneven, false, 'one person cannot be unevenly loaded');
  });

  it('has nothing to compare without analysts', () => {
    assert.deepEqual(assessWorkload([]), { members: 0, average: 0, highest: null, lowest: null, gap: 0, uneven: false });
    assert.equal(assessWorkload([member('Ana', 0, 'gestor')]).members, 0);
  });

  it('compares larger teams by the extremes', () => {
    assert.equal(assessWorkload([member('A', 6), member('B', 5), member('C', 5), member('D', 4)]).uneven, false);
    const result = assessWorkload([member('A', 12), member('B', 6), member('C', 5), member('D', 1)]);
    assert.equal(result.members, 4);
    assert.equal(result.average, 6);
    assert.equal(result.uneven, true);
  });
});
