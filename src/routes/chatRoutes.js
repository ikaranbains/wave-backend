import express from 'express';
import { body, param } from 'express-validator';
import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validate.js';
import { archiveAndDeleteMessage } from '../utils/deletedMessageArchive.js';
import { createAndBroadcastMessage } from '../services/messageService.js';

const router = express.Router();

function hidePrivatePresence(participant) {
  const serialized =
    typeof participant?.toObject === 'function' ? participant.toObject() : participant;
  if (serialized?.preferences?.showOnlineStatus === false) {
    serialized.status = 'offline';
    serialized.lastSeen = 'Private';
  }
  if (serialized) delete serialized.preferences;
  return serialized;
}

function sanitizeConversationPresence(conversation) {
  const serialized = conversation.toObject();
  serialized.participants = serialized.participants.map(hidePrivatePresence);
  return serialized;
}

// GET /api/conversations - List conversations for authenticated user
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const conversations = await Conversation.find({ participants: req.user.userId })
      .populate('participants', 'name email avatar status lastSeen preferences')
      .sort({ updatedAt: -1 });

    return res.json({
      conversations: conversations.map(sanitizeConversationPresence),
    });
  } catch (err) {
    console.error('Error fetching conversations:', err);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /api/messages/:conversationId - Get messages for a thread
router.get(
  '/messages/:conversationId',
  [authenticate, param('conversationId').isMongoId().withMessage('Invalid conversation ID'), validate],
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: req.user.userId,
      }).select('_id');

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const messages = await Message.find({ conversationId }).sort({ createdAt: 1 });
      return res.json({ messages });
    } catch (err) {
      console.error('Error fetching messages:', err);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }
  }
);

// POST /api/conversations/start - Start or retrieve direct conversation
router.post(
  '/conversations/start',
  [authenticate, body('targetUserId').isMongoId().withMessage('Invalid target user ID'), validate],
  async (req, res) => {
    try {
      const { targetUserId } = req.body;

      if (targetUserId === req.user.userId) {
        return res.status(400).json({ error: 'You cannot start a conversation with yourself' });
      }

      const targetUserExists = await User.exists({ _id: targetUserId });
      if (!targetUserExists) {
        return res.status(404).json({ error: 'Target user not found' });
      }

      let conversation = await Conversation.findOne({
        participants: { $all: [req.user.userId, targetUserId] },
        $expr: { $eq: [{ $size: '$participants' }, 2] },
      }).populate('participants', 'name email avatar status lastSeen preferences');

      if (!conversation) {
        conversation = await Conversation.create({
          participants: [req.user.userId, targetUserId],
          lastMessage: 'Conversation started',
        });
        conversation = await conversation.populate(
          'participants',
          'name email avatar status lastSeen preferences'
        );
      }

      return res.json({ conversation: sanitizeConversationPresence(conversation) });
    } catch (err) {
      console.error('Error starting conversation:', err);
      return res.status(500).json({ error: 'Failed to start conversation' });
    }
  }
);

// POST /api/messages - Send a message over HTTP.
// Used by the service worker when it flushes the offline outbox in the background,
// where no socket connection is available. clientId keeps the write idempotent.
router.post(
  '/messages',
  [
    authenticate,
    body('conversationId').isMongoId().withMessage('Invalid conversation ID'),
    body('clientId').optional().isString().isLength({ max: 80 }),
    body('text').optional().isString().isLength({ max: 8000 }),
    validate,
  ],
  async (req, res) => {
    try {
      const result = await createAndBroadcastMessage({
        io: req.app.get('io'),
        senderId: req.user.userId,
        data: req.body,
      });

      if (!result.ok) {
        return res.status(result.status || 400).json({ error: result.error });
      }

      return res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        messageId: result.messageId,
        message: result.message,
      });
    } catch (err) {
      console.error('Error sending message via REST:', err);
      return res.status(500).json({ error: 'Unable to send message' });
    }
  }
);

// DELETE /api/messages/:messageId - Delete a message for everyone
router.delete(
  '/messages/:messageId',
  [authenticate, param('messageId').trim().notEmpty().withMessage('Message ID required'), validate],
  async (req, res) => {
    try {
      const { messageId } = req.params;
      const isMongoId = mongoose.Types.ObjectId.isValid(messageId);
      const queryOr = [];
      if (isMongoId) queryOr.push({ _id: messageId });
      queryOr.push({ clientId: messageId });

      const message = await Message.findOne({ $or: queryOr });

      if (!message) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const conversation = await Conversation.findOne({
        _id: message.conversationId,
        participants: req.user.userId,
      }).select('participants');

      if (!conversation) {
        return res.status(403).json({ error: 'Not authorized to delete this message' });
      }

      const deletedMessage = await archiveAndDeleteMessage(message, req.user.userId);

      const roomTargets = [
        deletedMessage.conversationId,
        ...(conversation.participants || []).map((p) => `user:${p.toString()}`),
      ];

      const io = req.app.get('io');
      if (io) {
        io.to(roomTargets).emit('message_deleted', {
          ...deletedMessage,
        });
      }

      return res.json({
        ok: true,
        ...deletedMessage,
      });
    } catch (err) {
      console.error('Error deleting message via REST:', err);
      return res.status(500).json({ error: 'Failed to delete message' });
    }
  }
);

export const chatRoutes = router;
