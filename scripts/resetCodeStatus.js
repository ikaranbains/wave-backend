/**
 * Show which of the configured backup codes are still live. Ten codes means ten
 * resets, so this is how you know when to rotate them.
 * Run with: node scripts/resetCodeStatus.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
// Imported for its side effect: populate('userId') needs the User model registered.
import '../src/models/User.js';
import { UsedResetCode } from '../src/models/UsedResetCode.js';
import { hashBackupCode, readBackupCodes } from '../src/services/passwordResetService.js';

const codes = readBackupCodes();
if (codes.length === 0) {
  console.log('PASSWORD_RESET_BACKUP_CODES is not set — password resets are disabled.');
  process.exit(0);
}

await mongoose.connect(process.env.MONGODB_URI);

const spent = new Map(
  (await UsedResetCode.find().populate('userId', 'email').lean()).map((row) => [
    row.codeHash,
    row,
  ])
);

let available = 0;
codes.forEach((code, index) => {
  const used = spent.get(hashBackupCode(code));
  if (!used) {
    available += 1;
    console.log(`  ${String(index + 1).padStart(2)}. ${code}  AVAILABLE`);
    return;
  }
  const who = used.userId?.email || used.userId || 'unknown';
  console.log(
    `  ${String(index + 1).padStart(2)}. ${code}  used ${used.createdAt.toISOString()} by ${who}`
  );
});

console.log(`\n${available} of ${codes.length} codes still available.`);
if (available === 0) {
  console.log('Run scripts/generateResetCodes.js and replace PASSWORD_RESET_BACKUP_CODES.');
}

// Rows whose code is no longer configured: retired codes stay recorded on purpose, so
// a code that comes back into the env cannot be spent a second time.
const retired = [...spent.keys()].filter(
  (hash) => !codes.some((code) => hashBackupCode(code) === hash)
).length;
if (retired > 0) console.log(`${retired} used code(s) from a previous set, kept as spent.`);

await mongoose.disconnect();
