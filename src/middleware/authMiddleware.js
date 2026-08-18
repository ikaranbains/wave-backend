import jwt from 'jsonwebtoken';

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return process.env.JWT_SECRET;
}

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
    },
    getJwtSecret(),
    {
      expiresIn: '7d',
      issuer: 'wave-api',
      audience: 'wave-client',
    }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret(), {
    issuer: 'wave-api',
    audience: 'wave-client',
  });
}

export const AUTH_COOKIE_NAME = 'wave_session';

export function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) return cookies;
    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

export function getRequestAccessToken(req) {
  const authHeader = req.get('authorization');
  const bearerToken = authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return bearerToken || parseCookies(req.get('cookie'))[AUTH_COOKIE_NAME];
}

export function authenticate(req, res, next) {
  const token = getRequestAccessToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = {
      userId: decoded.sub,
      email: decoded.email,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}
