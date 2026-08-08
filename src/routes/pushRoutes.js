import express from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validate.js';
import {
  getPushPublicKey,
  isPushConfigured,
  removeSubscription,
  saveSubscription,
} from '../services/pushService.js';

const router = express.Router();

// GET /api/push/public-key - VAPID application server key for the browser
router.get('/public-key', (req, res) => {
  return res.json({
    enabled: isPushConfigured(),
    publicKey: getPushPublicKey(),
  });
});

// POST /api/push/subscribe - Register this browser/device for web push
router.post(
  '/subscribe',
  [
    authenticate,
    body('subscription.endpoint').isURL({ protocols: ['https'], require_protocol: true }),
    body('subscription.keys.p256dh').isString().notEmpty(),
    body('subscription.keys.auth').isString().notEmpty(),
    validate,
  ],
  async (req, res) => {
    if (!isPushConfigured()) {
      return res.status(503).json({ error: 'Push notifications are not configured' });
    }

    try {
      await saveSubscription(
        req.user.userId,
        req.body.subscription,
        req.get('user-agent') || ''
      );
      return res.status(201).json({ ok: true });
    } catch (error) {
      console.error('Error saving push subscription:', error);
      return res.status(400).json({ error: error.message || 'Unable to save subscription' });
    }
  }
);

// POST /api/push/unsubscribe - Forget this browser/device
router.post(
  '/unsubscribe',
  [authenticate, body('endpoint').isString().notEmpty(), validate],
  async (req, res) => {
    try {
      await removeSubscription(req.user.userId, req.body.endpoint);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Error removing push subscription:', error);
      return res.status(500).json({ error: 'Unable to remove subscription' });
    }
  }
);

export const pushRoutes = router;
