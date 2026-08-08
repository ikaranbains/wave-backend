import express from 'express';
import { body } from 'express-validator';
import { AccessToken } from 'livekit-server-sdk';
import { Conversation } from '../models/Conversation.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

function getLiveKitConfiguration() {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error('LiveKit is not configured');
  }

  return { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET };
}

router.post(
  '/token',
  [
    authenticate,
    body('conversationId').isMongoId().withMessage('Invalid conversation ID'),
    validate,
  ],
  async (req, res) => {
    try {
      const { conversationId } = req.body;
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: req.user.userId,
      }).select('_id');

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const user = await User.findById(req.user.userId).select('name email');
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } =
        getLiveKitConfiguration();
      const roomName = `pulse-chat-${conversationId}`;
      const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: req.user.userId,
        name: user.name,
        ttl: '2h',
        metadata: JSON.stringify({ email: user.email, conversationId }),
      });

      accessToken.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });

      return res.json({
        token: await accessToken.toJwt(),
        url: LIVEKIT_URL,
        roomName,
      });
    } catch (error) {
      console.error('Error generating LiveKit token:', error.message);
      return res.status(500).json({ error: 'Unable to join the call' });
    }
  }
);

export const callRoutes = router;
