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
        folder: 'pulse-chat/avatars',
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
