/**
 * One-off migration: drop the legacy `role` field ("Team Member") from users.
 *
 * Removing `role` from the Mongoose schema stops new writes and hides the value
 * from API responses, but Mongoose leaves unknown fields untouched in MongoDB —
 * so existing documents keep storing it until it is explicitly unset.
 *
 *   node scripts/removeRoleField.js            # report only, changes nothing
 *   node scripts/removeRoleField.js --apply    # perform the removal
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error('MONGODB_URI is not set. Add it to .env first.');
  process.exit(1);
}

try {
  await mongoose.connect(uri);
  const users = mongoose.connection.collection('users');

  const affected = await users.countDocuments({ role: { $exists: true } });
  const total = await users.countDocuments();
  console.log(`${affected} of ${total} user document(s) still carry a "role" field.`);

  if (affected === 0) {
    console.log('Nothing to do.');
  } else if (!apply) {
    const sample = await users
      .find({ role: { $exists: true } }, { projection: { name: 1, email: 1, role: 1 } })
      .limit(5)
      .toArray();
    console.log('\nSample of what would be removed:');
    sample.forEach((u) => console.log(`  ${u.email} → role: ${JSON.stringify(u.role)}`));
    console.log('\nDry run only. Re-run with --apply to remove the field.');
  } else {
    const result = await users.updateMany(
      { role: { $exists: true } },
      { $unset: { role: '' } }
    );
    console.log(`Removed "role" from ${result.modifiedCount} document(s).`);
  }
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
