import express from 'express';
import { body } from 'express-validator';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { validate } from '../middleware/validate.js';
import {
  AUTH_COOKIE_NAME,
  authenticate,
  signAccessToken,
} from '../middleware/authMiddleware.js';
import { clearLoginAttempts, loginRateLimit } from '../middleware/loginRateLimit.js';

const router = express.Router();

function getCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: process.env.AUTH_COOKIE_SAME_SITE || (isProduction ? 'none' : 'lax'),
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

function setSessionCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, getCookieOptions());
}

function serializeUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    status: user.status,
    statusMessage: user.statusMessage,
    preferences: user.preferences,
  };
}

// POST /api/auth/signup with express-validator
router.post(
  '/signup',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Please provide a valid email address'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    validate,
  ],
  async (req, res) => {
    try {
      const { name, email, password } = req.body;

      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        name,
        email: email.toLowerCase(),
        passwordHash,
        status: 'online',
      });

      const token = signAccessToken(user);
      setSessionCookie(res, token);

      return res.status(201).json({
        user: serializeUser(user),
      });
    } catch (err) {
      console.log('Error during signup:', err);
      return res.status(500).json({ error: 'Internal server error during signup' });
    }
  }
);

// POST /api/auth/login with express-validator
router.post(
  '/login',
  loginRateLimit,
  [
    body('email').isEmail().withMessage('Please provide a valid email address'),
    body('password').notEmpty().withMessage('Password is required'),
    validate,
  ],
  async (req, res) => {
    try {
      const { email, password } = req.body;

      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const isValidPassword = await bcrypt.compare(password, user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      user.status = 'online';
      user.lastSeen = 'Active now';
      await user.save();

      const token = signAccessToken(user);
      setSessionCookie(res, token);
      clearLoginAttempts(req);

      return res.json({
        user: serializeUser(user),
      });
    } catch (err) {
      console.log('Error during login:', err);
      return res.status(500).json({ error: 'Internal server error during login' });
    }
  }
);

router.post('/logout', (req, res) => {
  const clearOptions = getCookieOptions();
  delete clearOptions.maxAge;
  res.clearCookie(AUTH_COOKIE_NAME, clearOptions);
  return res.status(204).end();
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error fetching me' });
  }
});

export const authRoutes = router;
