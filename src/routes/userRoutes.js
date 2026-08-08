import express from 'express';
import { body, query } from 'express-validator';
import { User } from '../models/User.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = express.Router();

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
        filterQuery.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
        ];
      }

      const users = await User.find(filterQuery).select('-passwordHash').sort({ name: 1 });
      return res.json({
        users: users.map((user) => {
          const serialized = user.toObject();
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
