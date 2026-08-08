import { DeletedMessage } from '../models/DeletedMessage.js';
import { User } from '../models/User.js';

export async function archiveAndDeleteMessage(message, deletedByUserId) {
  const [sender, deletedBy] = await Promise.all([
    User.findById(message.senderId).select('name').lean(),
    User.findById(deletedByUserId).select('name').lean(),
  ]);

  const deletedAt = new Date();
  const originalMessage = message.toObject();

  await DeletedMessage.findOneAndUpdate(
    { originalMessageId: message._id },
    {
      $setOnInsert: {
        originalMessageId: message._id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        senderName: sender?.name || '',
        deletedById: deletedByUserId,
        deletedByName: deletedBy?.name || '',
        deletedAt,
        deletedDate: deletedAt.toISOString().slice(0, 10),
        messageText: message.text || '',
        clientId: message.clientId,
        attachment: message.attachment,
        replyTo: message.replyTo,
        status: message.status,
        originalCreatedAt: message.createdAt,
        originalUpdatedAt: message.updatedAt,
        originalMessage,
      },
    },
    { upsert: true }
  );

  await message.deleteOne();

  return {
    messageId: message._id.toString(),
    clientId: message.clientId,
    conversationId: message.conversationId.toString(),
  };
}
