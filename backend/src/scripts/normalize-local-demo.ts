import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { TicketModel } from '../models/ticket.model';
import { UserModel } from '../models/user.model';

/** Explicitly authorized local demo maintenance; never resets credentials or history. */
async function normalize(): Promise<void> {
  assert.equal(process.env.LOCAL_DEMO_MAINTENANCE, '1', 'Set LOCAL_DEMO_MAINTENANCE=1 explicitly');
  assert.notEqual(process.env.NODE_ENV, 'production', 'Demo maintenance is forbidden in production');
  assert.ok(/^mongodb:\/\/(localhost|127\.0\.0\.1):27017\/it-helpdesk(?:\?|$)/.test(env.MONGODB_URI),
    'Only the loopback development database is allowed');
  await mongoose.connect(env.MONGODB_URI);
  const specifications = [
    { email: 'demo.ti2@helpdesk.local', role: 'ti', previous: '[DEMO] Analista TI 2', name: 'João Silva' },
    { email: 'demo.solicitante2@helpdesk.local', role: 'solicitante', previous: '[DEMO] Solicitante 2', name: 'Maria Oliveira' },
  ] as const;
  const beforeUsers = await UserModel.find().select('+passwordHash').lean();
  const beforeTickets = await TicketModel.find().lean();
  // Validate both accounts before writing either; unrelated users are never renamed.
  for (const spec of specifications) {
    const user = beforeUsers.find(user => user.email === spec.email);
    assert.ok(user, `Demo user missing: ${spec.email}`);
    assert.equal(user.role, spec.role);
    assert.ok(user.name === spec.previous || user.name === spec.name, 'Unexpected demo account identity');
  }
  for (const spec of specifications) {
    await UserModel.updateOne({ email: spec.email, role: spec.role, name: spec.previous },
      { $set: { name: spec.name } }, { timestamps: false });
  }
  const demoEmails = ['ti@helpdesk.local', 'solicitante@helpdesk.local', 'gestor@helpdesk.local', ...specifications.map(spec => spec.email)];
  const demoIds = beforeUsers.filter(user => demoEmails.includes(user.email)).map(user => user._id);
  const tagged = await TicketModel.updateMany({ requester: { $in: demoIds },
    $or: [{ dataOrigin: { $exists: false } }, { dataOrigin: 'legacy' }] },
    { $set: { dataOrigin: 'demo' } }, { timestamps: false });
  const afterUsers = await UserModel.find().select('+passwordHash').lean();
  const afterTickets = await TicketModel.find().lean();
  for (const original of beforeUsers) {
    const actual = afterUsers.find(user => String(user._id) === String(original._id));
    const authorized = specifications.find(spec => spec.email === original.email);
    assert.ok(JSON.stringify(actual) === JSON.stringify({ ...original, ...(authorized ? { name: authorized.name } : {}) }),
      'Existing user changed outside the authorized name update');
  }
  for (const original of beforeTickets) {
    const actual = afterTickets.find(ticket => String(ticket._id) === String(original._id));
    const demo = demoIds.some(id => id.equals(original.requester)) && (original.dataOrigin === 'legacy' || original.dataOrigin === undefined);
    assert.ok(JSON.stringify(actual) === JSON.stringify({ ...original, ...(demo ? { dataOrigin: 'demo' } : {}) }),
      'Existing ticket changed outside demo classification');
  }
  console.log(`Two authorized demo names normalized; ${tagged.modifiedCount} demo tickets classified.`);
  console.log('IDs, credentials, relationships, timestamps and legacy events preserved; other accounts unchanged.');
}

normalize().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local demo maintenance failed');
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
