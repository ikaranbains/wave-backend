import express from 'express';
import { body, param, query } from 'express-validator';
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
  const serialized =
    typeof conversation?.toObject === 'function' ? conversation.toObject() : conversation;
  serialized.participants = serialized.participants.map(hidePrivatePresence);
  return serialized;
}

// GET /api/conversations - List conversations for authenticated user
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const conversations = await Conversation.find({ participants: req.user.userId })
      .populate('participants', 'name email avatar status lastSeen preferences')
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      conversations: conversations.map(sanitizeConversationPresence),
    });
  } catch (err) {
    console.error('Error fetching conversations:', err);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_PAGE_LIMIT = 100;

/**
 * Cursor filter for one page of thread history, walking backwards in time.
 *
 * createdAt alone is not a unique cursor: two messages sharing a millisecond at a
 * page boundary would drop one. The _id tie-break closes that hole. Exported so
 * scripts/messagePaginationSelfCheck.js exercises the real filter, not a copy.
 */
export function buildMessagePageFilter({ conversationId, before, beforeId }) {
  const filter = { conversationId };
  if (!before) return filter;

  const cursor = new Date(before);
  filter.$or = beforeId
    ? [{ createdAt: { $lt: cursor } }, { createdAt: cursor, _id: { $lt: beforeId } }]
    : [{ createdAt: { $lt: cursor } }];
  return filter;
}

// GET /api/messages/:conversationId - Get one page of a thread, newest page first
router.get(
  '/messages/:conversationId',
  [
    authenticate,
    param('conversationId').isMongoId().withMessage('Invalid conversation ID'),
    query('limit').optional().isInt({ min: 1, max: MESSAGE_PAGE_LIMIT }).toInt(),
    query('before').optional().isISO8601().withMessage('before must be an ISO 8601 date'),
    query('beforeId').optional().isMongoId().withMessage('Invalid beforeId'),
    validate,
  ],
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: req.user.userId,
      })
        .select('_id')
        .lean();

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const limit = req.query.limit || MESSAGE_PAGE_SIZE;
      const filter = buildMessagePageFilter({
        conversationId,
        before: req.query.before,
        beforeId: req.query.beforeId,
      });

      // One extra document is the cheapest way to know whether an older page exists.
      const page = await Message.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = page.length > limit;
      if (hasMore) page.pop();

      // Query order is newest-first for the limit; the client renders oldest-first.
      return res.json({ messages: page.reverse(), hasMore });
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

// POST /api/messages/batch - Flush up to 10 idempotent offline messages at once.
router.post(
  '/messages/batch',
  [
    authenticate,
    body('messages')
      .isArray({ min: 1, max: 10 })
      .withMessage('messages must contain between 1 and 10 items')
      .custom((messages) => {
        const clientIds = messages.map((message) => message?.clientId?.trim());
        return new Set(clientIds).size === clientIds.length;
      })
      .withMessage('clientId must be unique within a batch'),
    body('messages.*.conversationId').isMongoId().withMessage('Invalid conversation ID'),
    body('messages.*.clientId').isString().trim().notEmpty().isLength({ max: 80 }),
    body('messages.*.text').optional().isString().isLength({ max: 8000 }),
    validate,
  ],
  async (req, res) => {
    // Messages in one thread retain their queued order; unrelated threads run concurrently.
    const conversationTails = new Map();
    const attempts = await Promise.allSettled(
      req.body.messages.map((data) => {
        const previous = conversationTails.get(data.conversationId) || Promise.resolve();
        const attempt = previous.then(() =>
          createAndBroadcastMessage({
            io: req.app.get('io'),
            senderId: req.user.userId,
            data,
          })
        );
        conversationTails.set(data.conversationId, attempt.catch(() => {}));
        return attempt;
      })
    );

    const results = attempts.map((attempt, index) => {
      const clientId = req.body.messages[index].clientId;
      if (attempt.status === 'rejected') {
        console.error('Error sending batched message via REST:', attempt.reason);
        return { clientId, ok: false, status: 500, error: 'Unable to send message' };
      }

      const result = attempt.value;
      if (!result.ok) {
        return { clientId, ok: false, status: result.status || 400, error: result.error };
      }
      return {
        clientId,
        ok: true,
        status: result.duplicate ? 200 : 201,
        messageId: result.messageId,
        message: result.message,
      };
    });

    return res.json({ results });
  }
);

// POST /api/messages - Send a message over HTTP.
// Used by the service worker when it flushes one offline message in the background,
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
