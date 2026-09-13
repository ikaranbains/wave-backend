import express from 'express';
import { body } from 'express-validator';
import { AccessToken } from 'livekit-server-sdk';
import { Conversation } from '../models/Conversation.js';
import { User } from '../models/User.js';
import { Call } from '../models/Call.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

router.get('/history', authenticate, async (req, res) => {
  try {
    const currentUserId = req.user.userId;
    const calls = await Call.find({
      $or: [{ callerId: currentUserId }, { participantIds: currentUserId }],
    })
      .sort({ createdAt: -1 })
      .limit(60)
      .populate('callerId', 'name email avatar')
      .populate('participantIds', 'name email avatar')
      .populate('conversationId', '_id');

    const formattedCalls = calls.map((c) => {
      const isOutgoing = c.callerId?._id?.toString() === currentUserId;
      const peer = isOutgoing
        ? c.participantIds?.find((p) => p._id?.toString() !== currentUserId) || c.callerId
        : c.callerId;

      const durationSeconds =
        c.acceptedAt && c.endedAt
          ? Math.max(0, Math.round((new Date(c.endedAt) - new Date(c.acceptedAt)) / 1000))
          : 0;

      return {
        id: c._id.toString(),
        callId: c.callId,
        conversationId: c.conversationId?._id?.toString() || c.conversationId?.toString(),
        type: c.type || 'voice',
        status: c.status,
        outcome: c.outcome || (c.status === 'ended' ? 'completed' : 'missed'),
        direction: isOutgoing ? 'outgoing' : 'incoming',
        peer: peer
          ? {
              id: peer._id?.toString(),
              name: peer.name || 'User',
              email: peer.email,
              avatar: peer.avatar || null,
            }
          : { name: 'Wave User' },
        durationSeconds,
        createdAt: c.createdAt,
        acceptedAt: c.acceptedAt,
        endedAt: c.endedAt,
      };
    });

    return res.json({ calls: formattedCalls });
  } catch (error) {
    console.error('Error fetching call history:', error);
    return res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

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
      const roomName = `wave-${conversationId}`;
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
