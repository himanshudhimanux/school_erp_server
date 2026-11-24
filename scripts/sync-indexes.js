/**
 * Creates every index declared in the Mongoose schemas.
 *
 * Production runs with autoIndex off (building indexes on big collections at start-up is slow and
 * locks writes), so run this on every deploy, before restarting the API:
 *
 *   npm run db:indexes            create missing indexes (safe, never drops anything)
 *   npm run db:indexes -- --sync  also drop indexes that are no longer in any schema
 *
 * The unique indexes matter for correctness, not only speed: they enforce one attendance record
 * per student per day, one notification per dedupe key, unique receipt numbers and more.
 */
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db.js';
// Importing the app registers every model.
import { createApp } from '../src/app.js';

const sync = process.argv.includes('--sync');

async function main() {
  createApp();
  await connectDB();
  const models = Object.values(mongoose.models);
  for (const model of models) {
    const started = Date.now();
    if (sync) {
      const dropped = await model.syncIndexes();
      console.log(`${model.modelName.padEnd(24)} synced${dropped.length ? `, dropped ${dropped.join(', ')}` : ''} (${Date.now() - started} ms)`);
    } else {
      await model.createIndexes();
      console.log(`${model.modelName.padEnd(24)} ok (${Date.now() - started} ms)`);
    }
  }
  console.log(`\n${models.length} collections checked on database "${mongoose.connection.name}".`);
  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
