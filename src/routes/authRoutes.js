import express from 'express';
import multer from 'multer';
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
import {
  consumeBackupCode,
  isBackupCode,
  isPasswordResetConfigured,
} from '../services/passwordResetService.js';
import { cloudinary } from '../config/cloudinary.js';

const router = express.Router();
const signupPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      callback(new Error('Profile photos must be JPG or PNG images'));
      return;
    }
    callback(null, true);
  },
});

function receiveSignupPhoto(req, res, next) {
  signupPhotoUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Profile photos must be 2 MB or smaller' });
    }
    return res.status(400).json({ error: 'Choose a JPG or PNG profile photo' });
  });
}

function uploadSignupPhoto(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'wave/avatars',
        resource_type: 'image',
        transformation: [{ width: 512, height: 512, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(file.buffer);
  });
}

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
  receiveSignupPhoto,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Please provide a valid email address'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    body('statusMessage').optional().trim().isLength({ max: 160 }).withMessage('Bio must be 160 characters or fewer'),
    validate,
  ],
  async (req, res) => {
    let uploadedPhoto;
    let createdUser;
    try {
      const { name, email, password, statusMessage } = req.body;

      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      if (req.file) uploadedPhoto = await uploadSignupPhoto(req.file);

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        name,
        email: email.toLowerCase(),
        passwordHash,
        status: 'online',
        statusMessage: statusMessage || '',
        avatar: uploadedPhoto?.secure_url || '',
        avatarPublicId: uploadedPhoto?.public_id || '',
        avatarResourceType: uploadedPhoto?.resource_type || 'image',
      });
      createdUser = user;

      const token = signAccessToken(user);
      setSessionCookie(res, token);

      return res.status(201).json({
        user: serializeUser(user),
      });
    } catch (err) {
      if (uploadedPhoto?.public_id && !createdUser) {
        await cloudinary.uploader.destroy(uploadedPhoto.public_id, { resource_type: 'image' }).catch(() => {});
      }
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

// POST /api/auth/reset-password - Reset with a hand-issued backup code.
//
// Wave has no mail sender, so there is no emailed reset link. The operator hands a
// single-use code to the person who needs it. Deliberately not rate limited; every
// failure returns the same message so this cannot be used to discover which email
// addresses have accounts or which codes are live.
router.post(
  '/reset-password',
  [
    body('email').isEmail().withMessage('Please provide a valid email address'),
    body('backupCode').isString().trim().notEmpty().withMessage('Backup code is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long'),
    validate,
  ],
  async (req, res) => {
    const INVALID = 'That email and backup code do not match. Check both and try again.';
    try {
      if (!isPasswordResetConfigured()) {
        return res
          .status(503)
          .json({ error: 'Password resets are not available. Contact support.' });
      }

      const { email, backupCode, password } = req.body;
      const user = await User.findOne({ email: email.toLowerCase() });

      // Checked together so a wrong email and a wrong code are indistinguishable.
      if (!user || !isBackupCode(backupCode)) {
        return res.status(400).json({ error: INVALID });
      }

      // Claimed before the password is written, so a code cannot be spent twice even
      // if two requests arrive at once.
      const claimed = await consumeBackupCode(backupCode, user._id, req.ip);
      if (!claimed) {
        return res
          .status(400)
          .json({ error: 'That backup code has already been used. Ask for a new one.' });
      }

      user.passwordHash = await bcrypt.hash(password, 10);
      await user.save();
      // Someone resetting has usually just locked themselves out of /login. Clearing
      // the login limiter lets them sign in with the new password straight away.
      clearLoginAttempts(req);

      return res.json({ ok: true });
    } catch (err) {
      console.log('Error during password reset:', err);
      return res.status(500).json({ error: 'Internal server error during password reset' });
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
