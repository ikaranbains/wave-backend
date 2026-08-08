import { Message } from '../models/Message.js';
import { Conversation } from '../models/Conversation.js';
import { User } from '../models/User.js';
import mongoose from 'mongoose';
import { archiveAndDeleteMessage } from '../utils/deletedMessageArchive.js';
import {
  AUTH_COOKIE_NAME,
  parseCookies,
  verifyAccessToken,
} from '../middleware/authMiddleware.js';
import { randomUUID } from 'crypto';
import { createAndBroadcastMessage } from '../services/messageService.js';

const activeCalls = new Map();
const CALL_RING_TIMEOUT = 60_000;

function emitToCallParticipants(io, call, eventName, payload) {
  call.participantIds.forEach((participantId) => {
    io.to(`user:${participantId}`).emit(eventName, payload);
  });
}

function clearCall(callId) {
  const call = activeCalls.get(callId);
  if (call?.timeout) clearTimeout(call.timeout);
  activeCalls.delete(callId);
}

export function setupSocketIO(io) {
  io.use((socket, next) => {
    const bearerToken = socket.handshake.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const cookieToken = parseCookies(socket.handshake.headers.cookie)[AUTH_COOKIE_NAME];
    const token = socket.handshake.auth?.token || bearerToken || cookieToken;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = verifyAccessToken(token);
      socket.user = {
        userId: decoded.sub,
        email: decoded.email,
      };
      return next();
    } catch {
      return next(new Error('Invalid or expired access token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Socket client connected: ${socket.id}`);
    const authenticatedUserId = socket.user.userId;
    socket.join(`user:${authenticatedUserId}`);

    // Join conversation room
    socket.on('join_conversation', async (conversationId, acknowledge) => {
      try {
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: authenticatedUserId,
        }).select('_id');

        if (!conversation) {
          acknowledge?.({ ok: false, error: 'Conversation not found' });
          return;
        }

        await socket.join(conversationId);
        acknowledge?.({ ok: true });
        console.log(`Socket ${socket.id} joined conversation: ${conversationId}`);
      } catch (err) {
        console.error('Error joining conversation room:', err);
        acknowledge?.({ ok: false, error: 'Unable to join conversation' });
      }
    });

    // Handle real-time messaging
    socket.on('send_message', async (data, acknowledge) => {
      try {
        const result = await createAndBroadcastMessage({
          io,
          senderId: authenticatedUserId,
          data,
        });

        if (!result.ok) {
          acknowledge?.({ ok: false, error: result.error });
          return;
        }

        acknowledge?.({ ok: true, messageId: result.messageId });
      } catch (err) {
        console.error('Error persisting & broadcasting socket message:', err);
        acknowledge?.({ ok: false, error: 'Unable to send message' });
      }
    });

    // Handle real-time typing indicators
    socket.on('typing_start', ({ conversationId }) => {
      if (!conversationId) return;
      socket.to(conversationId).emit('user_typing', {
        conversationId,
        userId: authenticatedUserId,
      });
    });

    socket.on('typing_stop', ({ conversationId }) => {
      if (!conversationId) return;
      socket.to(conversationId).emit('user_stop_typing', {
        conversationId,
        userId: authenticatedUserId,
      });
    });

    // Handle real-time message deletion
    socket.on('delete_message', async (data, acknowledge) => {
      try {
        const { messageId, clientId, conversationId } = data || {};
        if (!messageId && !clientId) {
          acknowledge?.({ ok: false, error: 'Missing parameters' });
          return;
        }

        const isMongoId = mongoose.Types.ObjectId.isValid(messageId);
        const queryOr = [];
        if (isMongoId) queryOr.push({ _id: messageId });
        if (messageId) queryOr.push({ clientId: messageId });
        if (clientId) queryOr.push({ clientId: clientId });

        const messageQuery = conversationId
          ? { $or: queryOr, conversationId }
          : { $or: queryOr };

        const message = await Message.findOne(messageQuery);

        if (!message) {
          acknowledge?.({ ok: false, error: 'Message not found' });
          return;
        }

        const targetConvId = conversationId || message.conversationId.toString();

        const conversation = await Conversation.findOne({
          _id: targetConvId,
          participants: authenticatedUserId,
        }).select('_id participants');

        if (!conversation) {
          acknowledge?.({ ok: false, error: 'Not authorized to delete message' });
          return;
        }

        const deletedMessage = await archiveAndDeleteMessage(message, authenticatedUserId);

        const roomTargets = [
          targetConvId,
          ...(conversation.participants || []).map((p) => `user:${p.toString()}`),
        ];

        io.to(roomTargets).emit('message_deleted', {
          ...deletedMessage,
          conversationId: targetConvId,
        });

        acknowledge?.({ ok: true });
      } catch (err) {
        console.error('Error deleting message:', err);
        acknowledge?.({ ok: false, error: 'Unable to delete message' });
      }
    });

    socket.on('call_invite', async (data, acknowledge) => {
      try {
        const { conversationId, type } = data || {};
        if (!['voice', 'video'].includes(type)) {
          acknowledge?.({ ok: false, error: 'Invalid call type' });
          return;
        }

        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: authenticatedUserId,
        })
          .populate('participants', 'name avatar')
          .select('participants');

        if (!conversation) {
          acknowledge?.({ ok: false, error: 'Conversation not found' });
          return;
        }

        const caller = conversation.participants.find(
          (participant) => participant._id.toString() === authenticatedUserId
        );
        const recipientIds = conversation.participants
          .map((participant) => participant._id.toString())
          .filter((participantId) => participantId !== authenticatedUserId);

        if (!caller || recipientIds.length === 0) {
          acknowledge?.({ ok: false, error: 'No one is available to call' });
          return;
        }

        const participantIds = [authenticatedUserId, ...recipientIds];
        const hasBusyParticipant = [...activeCalls.values()].some((activeCall) =>
          activeCall.participantIds.some((participantId) =>
            participantIds.includes(participantId)
          )
        );
        if (hasBusyParticipant) {
          acknowledge?.({ ok: false, error: 'This contact is already on a call' });
          return;
        }

        const callId = randomUUID();
        const call = {
          callId,
          conversationId,
          type,
          callerId: authenticatedUserId,
          participantIds,
          status: 'ringing',
        };

        call.timeout = setTimeout(() => {
          emitToCallParticipants(io, call, 'call_ended', {
            callId,
            reason: 'missed',
          });
          clearCall(callId);
        }, CALL_RING_TIMEOUT);
        activeCalls.set(callId, call);

        recipientIds.forEach((recipientId) => {
          io.to(`user:${recipientId}`).emit('incoming_call', {
            callId,
            conversationId,
            type,
            caller: {
              id: caller._id.toString(),
              name: caller.name,
              avatar: caller.avatar,
            },
          });
        });

        acknowledge?.({
          ok: true,
          call: { callId, conversationId, type, status: 'ringing' },
        });
      } catch (error) {
        console.error('Error starting call:', error);
        acknowledge?.({ ok: false, error: 'Unable to start the call' });
      }
    });

    socket.on('call_accept', ({ callId } = {}, acknowledge) => {
      const call = activeCalls.get(callId);
      if (
        !call ||
        call.status !== 'ringing' ||
        !call.participantIds.includes(authenticatedUserId) ||
        call.callerId === authenticatedUserId
      ) {
        acknowledge?.({ ok: false, error: 'Call is no longer available' });
        return;
      }

      call.status = 'accepted';
      if (call.timeout) clearTimeout(call.timeout);
      call.timeout = setTimeout(() => {
        emitToCallParticipants(io, call, 'call_ended', {
          callId,
          reason: 'timeout',
        });
        clearCall(callId);
      }, 2 * 60 * 60 * 1000);
      emitToCallParticipants(io, call, 'call_accepted', {
        callId,
        conversationId: call.conversationId,
        type: call.type,
        acceptedBy: authenticatedUserId,
      });
      acknowledge?.({ ok: true });
    });

    socket.on('call_decline', ({ callId } = {}, acknowledge) => {
      const call = activeCalls.get(callId);
      if (!call || !call.participantIds.includes(authenticatedUserId)) {
        acknowledge?.({ ok: false, error: 'Call is no longer available' });
        return;
      }

      emitToCallParticipants(io, call, 'call_declined', {
        callId,
        declinedBy: authenticatedUserId,
      });
      clearCall(callId);
      acknowledge?.({ ok: true });
    });

    socket.on('call_end', ({ callId } = {}, acknowledge) => {
      const call = activeCalls.get(callId);
      if (!call || !call.participantIds.includes(authenticatedUserId)) {
        acknowledge?.({ ok: false, error: 'Call is no longer active' });
        return;
      }

      emitToCallParticipants(io, call, 'call_ended', {
        callId,
        endedBy: authenticatedUserId,
        reason: 'ended',
      });
      clearCall(callId);
      acknowledge?.({ ok: true });
    });

    // Presence update
    socket.on('user_online', async () => {
      const user = await User.findByIdAndUpdate(
        authenticatedUserId,
        {
          status: 'online',
          lastSeen: 'Active now',
        },
        { new: true }
      ).select('preferences.showOnlineStatus');
      io.emit('presence_change', {
        userId: authenticatedUserId,
        status: user?.preferences?.showOnlineStatus === false ? 'offline' : 'online',
      });
    });

    socket.on('disconnect', async () => {
      await User.findByIdAndUpdate(
        authenticatedUserId,
        {
          status: 'offline',
          lastSeen: new Date().toISOString(),
        }
      );
      io.emit('presence_change', { userId: authenticatedUserId, status: 'offline' });
      console.log(`🔌 Socket client disconnected: ${socket.id}`);
    });
  });
}
