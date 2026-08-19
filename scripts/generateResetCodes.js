/**
 * Print 10 fresh password reset backup codes for PASSWORD_RESET_BACKUP_CODES.
 * Run with: node scripts/generateResetCodes.js
 *
 * Replacing the env value retires every old code at once. Codes already spent stay
 * spent regardless — the usedresetcodes collection is what enforces that.
 */
import crypto from 'crypto';

// No I, O, 0 or 1: these get read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUPS = 4;
const GROUP_LENGTH = 4;

function generateCode() {
  return Array.from({ length: GROUPS }, () =>
    Array.from(crypto.randomBytes(GROUP_LENGTH))
      .map((byte) => ALPHABET[byte % ALPHABET.length])
      .join('')
  ).join('-');
}

const codes = Array.from({ length: 10 }, generateCode);
console.log('PASSWORD_RESET_BACKUP_CODES=' + codes.join(','));
console.log('\nHand out one at a time:');
codes.forEach((code, index) => console.log(`  ${index + 1}. ${code}`));
