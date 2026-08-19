/**
 * Self-check for the backup code comparison. A false positive here hands out every
 * account in the database, so the cases that matter are the near misses.
 * Run with: node scripts/passwordResetSelfCheck.js
 */
import assert from 'assert';
import {
  hashBackupCode,
  isBackupCode,
  isPasswordResetConfigured,
  readBackupCodes,
} from '../src/services/passwordResetService.js';

process.env.PASSWORD_RESET_BACKUP_CODES = ' AAAA-BBBB , CCCC-DDDD ,, EEEE-FFFF ';
assert.deepStrictEqual(
  readBackupCodes(),
  ['AAAA-BBBB', 'CCCC-DDDD', 'EEEE-FFFF'],
  'codes are trimmed and blanks dropped'
);
assert.strictEqual(isPasswordResetConfigured(), true);

assert.strictEqual(isBackupCode('AAAA-BBBB'), true, 'first code matches');
assert.strictEqual(isBackupCode('EEEE-FFFF'), true, 'last code matches');
assert.strictEqual(isBackupCode('CCCC-DDDD'), true, 'middle code matches');

// Case and surrounding whitespace are normalised, because a code that is checked and
// claimed under two different digests could be spent twice. The codes are uppercase
// only, so folding case cannot make two distinct codes collide.
assert.strictEqual(isBackupCode('aaaa-bbbb'), true, 'lowercase is the same code');
assert.strictEqual(isBackupCode('  AAAA-BBBB  '), true, 'padded is the same code');
assert.strictEqual(
  hashBackupCode('aaaa-bbbb'),
  hashBackupCode('AAAA-BBBB'),
  'check and claim must agree on the digest, or the code is spendable twice'
);

// Near misses must all fail — no prefix or separator leniency.
assert.strictEqual(isBackupCode('AAAA-BBB'), false, 'truncated code');
assert.strictEqual(isBackupCode('AAAA-BBBBB'), false, 'extended code');
assert.strictEqual(isBackupCode('AAAABBBB'), false, 'missing separator');
assert.strictEqual(isBackupCode('ZZZZ-ZZZZ'), false, 'unknown code');
assert.strictEqual(isBackupCode(''), false, 'empty string');
assert.strictEqual(isBackupCode(undefined), false, 'missing value');
assert.strictEqual(isBackupCode(null), false, 'null value');
assert.strictEqual(isBackupCode(123), false, 'non-string');

// With nothing configured nothing may pass, least of all an empty submission.
process.env.PASSWORD_RESET_BACKUP_CODES = '';
assert.strictEqual(isPasswordResetConfigured(), false, 'unset means not configured');
assert.strictEqual(isBackupCode(''), false, 'no codes, empty candidate');
assert.strictEqual(isBackupCode('AAAA-BBBB'), false, 'no codes, real-looking candidate');

// Hashing is what makes the constant-time compare possible, so it must be stable.
assert.strictEqual(hashBackupCode('AAAA-BBBB'), hashBackupCode('AAAA-BBBB'));
assert.notStrictEqual(hashBackupCode('AAAA-BBBB'), hashBackupCode('AAAA-BBBC'));
assert.strictEqual(hashBackupCode('x').length, 64, 'sha256 hex is fixed width');

console.log('✅ password reset self-check passed');
