const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function getAttemptKey(req) {
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'unknown';
  return `${req.ip}:${email}`;
}

export function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = getAttemptKey(req);
  const current = attempts.get(key);

  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (current.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
  }

  current.count += 1;
  return next();
}

export function clearLoginAttempts(req) {
  attempts.delete(getAttemptKey(req));
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  attempts.forEach((value, key) => {
    if (value.resetAt <= now) attempts.delete(key);
  });
}, WINDOW_MS);
cleanupTimer.unref();
