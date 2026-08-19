/**
 * Proves a backup code cannot be spent twice, against a real MongoDB and the real
 * unique index — the guarantee lives in that index, so an in-memory fake would prove
 * nothing. Runs in a scratch database that is dropped at the end; it never touches the
 * application data.
 *
 * Run with: node scripts/backupCodeSingleUseCheck.js
 */
import 'dotenv/config';
import assert from 'assert';
import mongoose from 'mongoose';
import { UsedResetCode } from '../src/models/UsedResetCode.js';
import { consumeBackupCode, isBackupCode } from '../src/services/passwordResetService.js';

const SCRATCH_DB = 'wave_backupcode_check';
const CODES = Array.from({ length: 10 }, (_, index) => `TEST-CODE-${index}`);
process.env.PASSWORD_RESET_BACKUP_CODES = CODES.join(',');

function scratchUri() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  // Swap only the database path, keeping credentials, host and options intact.
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?/, `$1/${SCRATCH_DB}`);
}

const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();

await mongoose.connect(scratchUri());
await mongoose.connection.dropDatabase();
await UsedResetCode.syncIndexes();

// 1. A code works the first time.
assert.strictEqual(await consumeBackupCode(CODES[0], alice), true, 'first use succeeds');

// 2. The same code never works again — not for the same user...
assert.strictEqual(
  await consumeBackupCode(CODES[0], alice),
  false,
  'the same user cannot re-spend a code'
);
// ...and not for a different account, which is the case that would matter most.
assert.strictEqual(
  await consumeBackupCode(CODES[0], bob),
  false,
  'a spent code cannot be handed on to another account'
);

// 3. Case and padding are the same code, or a code would be worth several resets.
assert.strictEqual(
  await consumeBackupCode(` ${CODES[1].toLowerCase()} `, alice),
  true,
  'lowercase padded code spends'
);
assert.strictEqual(
  await consumeBackupCode(CODES[1], bob),
  false,
  'the canonical form of an already-spent code is rejected'
);

// 4. Two requests racing with one code: exactly one wins. The unique index decides,
//    which is why the claim is an insert and not a read-then-write.
const raced = await Promise.all([
  consumeBackupCode(CODES[2], alice),
  consumeBackupCode(CODES[2], bob),
  consumeBackupCode(CODES[2], alice),
]);
assert.strictEqual(
  raced.filter(Boolean).length,
  1,
  `exactly one concurrent claim may win, got ${raced.filter(Boolean).length}`
);

// 5. Ten codes means ten resets, then no more until the codes are rotated.
for (const code of CODES.slice(3)) {
  assert.strictEqual(await consumeBackupCode(code, alice), true, `${code} spends once`);
}
assert.strictEqual(await UsedResetCode.countDocuments(), 10, 'all ten codes recorded');
for (const code of CODES) {
  assert.strictEqual(
    await consumeBackupCode(code, bob),
    false,
    `${code} is exhausted, so resets are over until the codes are replaced`
  );
}

// 6. Rotating PASSWORD_RESET_BACKUP_CODES restores ten chances, and the retired codes
//    stay retired — the used rows outlive the env value.
process.env.PASSWORD_RESET_BACKUP_CODES = 'FRESH-CODE-1,FRESH-CODE-2';
assert.strictEqual(isBackupCode(CODES[0]), false, 'a retired code is no longer accepted');
assert.strictEqual(isBackupCode('FRESH-CODE-1'), true, 'a rotated-in code is accepted');
assert.strictEqual(
  await consumeBackupCode('FRESH-CODE-1', bob),
  true,
  'rotation gives fresh chances'
);

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log('✅ backup codes are single-use: 10 codes, 10 resets, no re-use, race safe');
