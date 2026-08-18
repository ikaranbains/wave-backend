import express from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validate.js';
import {
  getPushPublicKey,
  isPushConfigured,
  removeToken,
  saveToken,
} from '../services/pushService.js';

const router = express.Router();

// GET /api/push/public-key - Firebase Web Push certificate key for getToken({ vapidKey })
router.get('/public-key', (req, res) => {
  return res.json({
    enabled: isPushConfigured(),
    publicKey: getPushPublicKey(),
  });
});

// POST /api/push/subscribe - Register this browser's FCM registration token
router.post(
  '/subscribe',
  [authenticate, body('token').isString().isLength({ min: 20, max: 4096 }), validate],
  async (req, res) => {
    if (!isPushConfigured()) {
      return res.status(503).json({ error: 'Push notifications are not configured' });
    }

    try {
      await saveToken(req.user.userId, req.body.token, req.get('user-agent') || '');
      return res.status(201).json({ ok: true });
    } catch (error) {
      console.error('Error saving FCM token:', error);
      return res.status(400).json({ error: error.message || 'Unable to save token' });
    }
  }
);

// POST /api/push/unsubscribe - Forget this browser/device
router.post(
  '/unsubscribe',
  [authenticate, body('token').isString().notEmpty(), validate],
  async (req, res) => {
    try {
      await removeToken(req.user.userId, req.body.token);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Error removing FCM token:', error);
      return res.status(500).json({ error: 'Unable to remove token' });
    }
  }
);

export const pushRoutes = router;
