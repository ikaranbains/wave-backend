import express from 'express';
import multer from 'multer';
import { cloudinary } from '../config/cloudinary.js';
import { body, query } from 'express-validator';
import { User } from '../models/User.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = express.Router();
const USER_SEARCH_LIMIT = 30;

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    callback(null, ['image/jpeg', 'image/png'].includes(file.mimetype));
  },
});

function receiveAvatar(req, res, next) {
  avatarUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Profile photos must be 2 MB or smaller' });
    }
    return res.status(400).json({ error: 'Choose a JPG or PNG profile photo' });
  });
}

function uploadAvatarBuffer(file) {
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

// GET /api/users - List the people you can message
router.get(
  '/',
  [authenticate, query('search').optional().trim(), validate],
  async (req, res) => {
    try {
      const { search } = req.query;
      const filterQuery = {
        _id: { $ne: req.user.userId },
      };

      if (search) {
        const escapedSearch = escapeRegex(search);
        filterQuery.$or = [
          { name: { $regex: escapedSearch, $options: 'i' } },
          { email: { $regex: escapedSearch, $options: 'i' } },
        ];
      }

      const users = await User.find(filterQuery)
        .select('-passwordHash')
        .sort({ name: 1 })
        .limit(USER_SEARCH_LIMIT)
        .lean();
      return res.json({
        users: users.map((user) => {
          const serialized = user;
          if (serialized.preferences?.showOnlineStatus === false) {
            serialized.status = 'offline';
            serialized.lastSeen = 'Private';
          }
          delete serialized.preferences;
          return serialized;
        }),
      });
    } catch (err) {
      console.error('Error fetching users:', err);
      return res.status(500).json({ error: 'Failed to load people' });
    }
  }
);

router.post('/me/avatar', authenticate, receiveAvatar, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a JPG or PNG profile photo' });

  let uploadedAvatar;
  try {
    uploadedAvatar = await uploadAvatarBuffer(req.file);
    const previousUser = await User.findById(req.user.userId).select('avatarPublicId avatarResourceType');
    if (!previousUser) {
      await cloudinary.uploader.destroy(uploadedAvatar.public_id, { resource_type: 'image' });
      return res.status(404).json({ error: 'User not found' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      {
        $set: {
          avatar: uploadedAvatar.secure_url,
          avatarPublicId: uploadedAvatar.public_id,
          avatarResourceType: uploadedAvatar.resource_type || 'image',
        },
      },
      { new: true, runValidators: true }
    ).select('-passwordHash');

    if (previousUser.avatarPublicId) {
      await cloudinary.uploader
        .destroy(previousUser.avatarPublicId, {
          resource_type: previousUser.avatarResourceType || 'image',
        })
        .catch((error) =>
          console.error('Previous profile photo cleanup failed:', error.message)
        );
    }

    return res.json({ user });
  } catch (error) {
    if (uploadedAvatar?.public_id) {
      await cloudinary.uploader.destroy(uploadedAvatar.public_id, { resource_type: 'image' }).catch(() => {});
    }
    console.error('Profile photo update failed:', error.message);
    return res.status(502).json({ error: 'Unable to update profile photo' });
  }
});

router.patch(
  '/me/settings',
  [
    authenticate,
    body('name').trim().isLength({ min: 1, max: 80 }).withMessage('Name must be 1–80 characters'),
    body('statusMessage')
      .optional()
      .trim()
      .isLength({ max: 160 })
      .withMessage('Status message must be 160 characters or fewer'),
    body('preferences.notificationsEnabled').isBoolean(),
    body('preferences.soundEnabled').isBoolean(),
    body('preferences.showOnlineStatus').isBoolean(),
    validate,
  ],
  async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.user.userId,
        {
          $set: {
            name: req.body.name,
            statusMessage: req.body.statusMessage || '',
            'preferences.notificationsEnabled': req.body.preferences.notificationsEnabled,
            'preferences.soundEnabled': req.body.preferences.soundEnabled,
            'preferences.showOnlineStatus': req.body.preferences.showOnlineStatus,
          },
        },
        { new: true, runValidators: true }
      ).select('-passwordHash');

      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user });
    } catch (error) {
      console.error('Error updating user settings:', error);
      return res.status(500).json({ error: 'Failed to save settings' });
    }
  }
);

export const userRoutes = router;
