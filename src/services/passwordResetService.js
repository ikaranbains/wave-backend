import crypto from 'crypto';
import { UsedResetCode } from '../models/UsedResetCode.js';

/**
 * Password resets are done with a fixed set of backup codes handed out by hand — there
 * is no mail sender in Wave. Codes live in PASSWORD_RESET_BACKUP_CODES rather than in
 * source so they are never committed, and each one works exactly once.
 */
export function readBackupCodes() {
  return (process.env.PASSWORD_RESET_BACKUP_CODES || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

export function isPasswordResetConfigured() {
  return readBackupCodes().length > 0;
}

/**
 * Normalising here rather than at the call sites is what keeps a code single-use: the
 * check and the claim must hash a code to the same digest, or 'abcd' and 'ABCD' would
 * each get to spend the same code once. Case folding costs no entropy — the code
 * alphabet is uppercase-only, so two valid codes cannot collide under toUpperCase.
 */
export function hashBackupCode(code) {
  const normalized = String(code).trim().toUpperCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Whether `candidate` is one of the configured codes, compared without leaking how
 * much of a wrong code was correct. Hashing first makes every comparison the same
 * length, so timingSafeEqual can be used without a length check giving the game away.
 */
export function isBackupCode(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;

  const candidateDigest = Buffer.from(hashBackupCode(candidate), 'hex');
  // Reduce, not some(): every code is compared, so the time taken says nothing about
  // which one matched or how early the match was.
  return readBackupCodes().reduce((matched, code) => {
    const isMatch = crypto.timingSafeEqual(
      candidateDigest,
      Buffer.from(hashBackupCode(code), 'hex')
    );
    return matched || isMatch;
  }, false);
}

/**
 * Claim a code for this user. Returns false when the code has already been spent,
 * which the unique index decides rather than a read-then-write that could race.
 */
export async function consumeBackupCode(code, userId, ip = '') {
  try {
    await UsedResetCode.create({ codeHash: hashBackupCode(code), userId, ip });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}
