import mongoose from 'mongoose';
import { env } from '../config/env';
import { assertLocalDemoSeed, seedManagerDemo } from '../services/manager-demo';
async function run() {
  assertLocalDemoSeed(env.MONGODB_URI, process.env.NODE_ENV, process.env.LOCAL_DEMO_SEED);
  await mongoose.connect(env.MONGODB_URI);
  console.log('New fictitious manager fixtures:', await seedManagerDemo(new Date(), env.APP_TIMEZONE));
}
run().catch(() => { console.error('Demo seed refused or failed. Check the local guard and existing demo accounts. No existing records are overwritten.'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
