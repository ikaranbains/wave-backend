import mongoose from 'mongoose';
import { Call } from '../models/Call.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { sendPushToUser } from './pushService.js';

const cloudinaryAttachmentTypes = new Set(['image', 'video', 'audio', 'file']);

export function normalizeAttachment(attachment) {
  if (!attachment?.url) return undefined;

  let attachmentUrl;
  try {
    attachmentUrl = new URL(attachment.url);
  } catch {
    return null;
  }

  if (
    attachmentUrl.protocol !== 'https:' ||
    attachmentUrl.hostname !== 'res.cloudinary.com' ||
    !cloudinaryAttachmentTypes.has(attachment.type)
  ) {
    return null;
  }

  return {
    type: attachment.type,
    url: attachmentUrl.toString(),
    name: String(attachment.name || 'Attachment').slice(0, 180),
    size: attachment.size ? String(attachment.size).slice(0, 30) : undefined,
    bytes: Number.isFinite(Number(attachment.bytes)) ? Number(attachment.bytes) : undefined,
    mimeType: attachment.mimeType ? String(attachment.mimeType).slice(0, 120) : undefined,
    publicId: attachment.publicId ? String(attachment.publicId).slice(0, 240) : undefined,
    resourceType: attachment.resourceType
      ? String(attachment.resourceType).slice(0, 30)
      : undefined,
  };
}

export function getAttachmentSummary(attachment) {
  if (attachment?.type === 'image') return 'Sent a photo';
  if (attachment?.type === 'video') return 'Sent a video';
  if (attachment?.type === 'audio') return 'Sent an audio file';
  return 'Sent a document';
}

function normalizeReplyTo(replyTo) {
  if (!replyTo) return undefined;
  const hasContent =
    replyTo.id || replyTo.senderName || replyTo.text || replyTo.attachmentUrl;
  if (!hasContent) return undefined;

  return {
    id: String(replyTo.id || '').slice(0, 80),
    senderName: String(replyTo.senderName || '').slice(0, 100),
    text: String(replyTo.text || '').slice(0, 200),
    attachmentType: replyTo.attachmentType
      ? String(replyTo.attachmentType).slice(0, 30)
      : undefined,
    attachmentName: replyTo.attachmentName
      ? String(replyTo.attachmentName).slice(0, 150)
      : undefined,
    attachmentUrl: replyTo.attachmentUrl ? String(replyTo.attachmentUrl) : undefined,
  };
}

/**
 * True only while the user has a client that can actually show them the message.
 *
 * An open socket is not enough: a backgrounded PWA and a hidden browser tab keep
 * theirs alive, so gating push on socket presence silently swallowed every
 * notification for exactly the case push exists for. Clients report visibility over
 * `app_visibility`; one that never reports is assumed visible, which is the old
 * behaviour and keeps an older build from being spammed with duplicate pushes.
 */
export function hasVisibleClient(io, userId) {
  const room = io?.sockets?.adapter?.rooms?.get(`user:${userId}`);
  if (!room || room.size === 0) return false;

  for (const socketId of room) {
    if (io.sockets.sockets.get(socketId)?.data?.isVisible !== false) return true;
  }
  return false;
}

/**
 * Notify participants who currently have no connected socket. Web push is the only
 * way a message reaches an installed PWA that is closed or backgrounded.
 */
async function notifyOfflineParticipants({ io, conversation, senderId, message }) {
  const recipientIds = (conversation.participants || [])
    .map((participant) => participant.toString())
    .filter((participantId) => participantId !== senderId.toString());

  const offlineRecipientIds = recipientIds.filter(
    (recipientId) => !hasVisibleClient(io, recipientId)
  );
  if (offlineRecipientIds.length === 0) return;

  const [sender, recipients] = await Promise.all([
    User.findById(senderId).select('name avatar'),
    User.find({ _id: { $in: offlineRecipientIds } }).select(
      'preferences.notificationsEnabled'
    ),
  ]);

  const preview =
    message.text || getAttachmentSummary(message.attachment) || 'New message';

  await Promise.all(
    recipients
      .filter((recipient) => recipient.preferences?.notificationsEnabled !== false)
      .map((recipient) =>
        sendPushToUser(recipient._id, {
          title: sender?.name || 'Wave',
          body: preview.slice(0, 160),
          icon: '/wave-192.png',
          badge: '/wave-badge.png',
          tag: `conversation-${message.conversationId}`,
          data: {
            conversationId: message.conversationId.toString(),
            messageId: message._id.toString(),
            url: '/',
          },
        }).catch((error) => console.error('Unable to queue web push:', error.message))
      )
  );
}

function formatCallDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

/** Preview text for the conversation list — the client renders its own label. */
export function getCallEventSummary({ type, outcome, durationSeconds }) {
  const kind = type === 'video' ? 'Video call' : 'Voice call';
  if (outcome === 'completed') return `${kind} · ${formatCallDuration(durationSeconds)}`;
  if (outcome === 'missed') return `Missed ${kind.toLowerCase()}`;
  if (outcome === 'declined') return `Declined ${kind.toLowerCase()}`;
  return `Cancelled ${kind.toLowerCase()}`;
}

/**
 * Record a finished call as a message in the thread, the way WhatsApp does.
 * Persisted rather than emitted transiently so the log survives a reload and
 * shows up for a participant who was offline when the call happened.
 *
 * The caller is the sender, so the entry sits on the caller's side of the
 * thread and reads as incoming for whoever was called.
 */
export async function createCallEventMessage({
  io,
  conversationId,
  callerId,
  callEvent,
  callDocId,
  callId,
}) {
  try {
    // Atomically claim the right to log this call. If another path (hang-up
    // racing a timeout, or a restart sweep) already claimed it, stop here —
    // this is what keeps exactly one entry per call.
    const claimId = new mongoose.Types.ObjectId();
    if (callDocId) {
      const claimed = await Call.findOneAndUpdate(
        { _id: callDocId, loggedMessageId: { $exists: false } },
        { $set: { loggedMessageId: claimId } },
        { new: false }
      );
      if (!claimed) return null;
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: callerId,
    }).select('_id participants');
    if (!conversation) return null;

    const summary = getCallEventSummary(callEvent);
    const message = await Message.create({
      _id: claimId,
      conversationId,
      senderId: callerId,
      // Messages carry a unique {senderId, clientId} index, and a compound
      // sparse index still indexes a doc when only senderId is set — so leaving
      // this null let a sender log exactly one call ever, every later one
      // failing on duplicate key. Keying it to the call also makes the write
      // idempotent at the database level.
      clientId: callId ? `call-${callId}` : undefined,
      text: '',
      callEvent: {
        type: callEvent.type === 'video' ? 'video' : 'voice',
        outcome: callEvent.outcome,
        durationSeconds: Math.max(0, Math.round(callEvent.durationSeconds || 0)),
      },
      status: 'sent',
    });

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: summary,
      updatedAt: new Date(),
    });

    const roomTargets = [
      String(conversationId),
      ...(conversation.participants || []).map((p) => `user:${p.toString()}`),
    ];
    io?.to(roomTargets).emit('receive_message', message.toJSON());

    return message;
  } catch (error) {
    // A failed call log must never take down call teardown.
    console.error('Unable to record call event:', error.message);
    return null;
  }
}

/**
 * Validate, persist and fan out a chat message. Shared by the socket handler and the
 * REST endpoint the service worker uses when flushing its offline outbox.
 */
export async function createAndBroadcastMessage({ io, senderId, data }) {
  const { conversationId, text, attachment, clientId, replyTo } = data || {};
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  const normalizedAttachment = normalizeAttachment(attachment);
  const normalizedClientId =
    typeof clientId === 'string' ? clientId.trim().slice(0, 80) : undefined;
  const normalizedReplyTo = normalizeReplyTo(replyTo);

  if (attachment?.url && !normalizedAttachment) {
    return { ok: false, status: 400, error: 'Invalid attachment' };
  }

  if (!normalizedText && !normalizedAttachment) {
    return { ok: false, status: 400, error: 'Message content is required' };
  }

  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: senderId,
  }).select('_id participants');

  if (!conversation) {
    return { ok: false, status: 404, error: 'Conversation not found' };
  }

  // The unique partial {senderId, clientId} index is already the idempotency guard,
  // so a retry collides on insert. Letting it collide costs a lookup only on the rare
  // duplicate, where pre-checking cost one on every message sent.
  let newMessage;
  try {
    newMessage = await Message.create({
      conversationId,
      senderId,
      clientId: normalizedClientId,
      text: normalizedText,
      attachment: normalizedAttachment,
      replyTo: normalizedReplyTo,
      status: 'sent',
    });
  } catch (error) {
    if (error?.code !== 11000 || !normalizedClientId) throw error;

    const existingMessage = await Message.findOne({
      senderId,
      clientId: normalizedClientId,
    });
    if (!existingMessage) throw error;

    return {
      ok: true,
      duplicate: true,
      messageId: existingMessage._id.toString(),
      message: existingMessage.toJSON(),
    };
  }

  const unreadIncrements = Object.fromEntries(
    conversation.participants
      .map((participant) => participant.toString())
      .filter((participantId) => participantId !== senderId.toString())
      .map((participantId) => [`unreadCounts.${participantId}`, 1])
  );
  await Conversation.findByIdAndUpdate(conversationId, {
    $set: {
      lastMessage: normalizedText || getAttachmentSummary(normalizedAttachment),
      updatedAt: new Date(),
    },
    $inc: unreadIncrements,
  });

  const roomTargets = [
    String(conversationId),
    ...(conversation.participants || []).map((participant) => `user:${participant.toString()}`),
  ];

  io?.to(roomTargets).emit('receive_message', newMessage.toJSON());

  // Push notifications are best-effort and must not hold up the socket ack.
  // Free-tier push/database latency should not make the sender's composer feel
  // blocked after the message has already been persisted and broadcast.
  void notifyOfflineParticipants({
    io,
    conversation,
    senderId,
    message: newMessage,
  }).catch((error) => console.error('Unable to notify offline participants:', error.message));

  return {
    ok: true,
    messageId: newMessage._id.toString(),
    message: newMessage.toJSON(),
  };
}
