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

function hasLiveSocket(io, userId) {
  const room = io?.sockets?.adapter?.rooms?.get(`user:${userId}`);
  return Boolean(room && room.size > 0);
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
    (recipientId) => !hasLiveSocket(io, recipientId)
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
          badge: '/wave-192.png',
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

  if (normalizedClientId) {
    const existingMessage = await Message.findOne({
      senderId,
      clientId: normalizedClientId,
    });
    if (existingMessage) {
      return {
        ok: true,
        duplicate: true,
        messageId: existingMessage._id.toString(),
        message: existingMessage.toJSON(),
      };
    }
  }

  const newMessage = await Message.create({
    conversationId,
    senderId,
    clientId: normalizedClientId,
    text: normalizedText,
    attachment: normalizedAttachment,
    replyTo: normalizedReplyTo,
    status: 'sent',
  });

  await Conversation.findByIdAndUpdate(conversationId, {
    lastMessage: normalizedText || getAttachmentSummary(normalizedAttachment),
    updatedAt: new Date(),
  });

  const roomTargets = [
    String(conversationId),
    ...(conversation.participants || []).map((participant) => `user:${participant.toString()}`),
  ];

  io?.to(roomTargets).emit('receive_message', newMessage.toJSON());

  await notifyOfflineParticipants({
    io,
    conversation,
    senderId,
    message: newMessage,
  });

  return {
    ok: true,
    messageId: newMessage._id.toString(),
    message: newMessage.toJSON(),
  };
}
