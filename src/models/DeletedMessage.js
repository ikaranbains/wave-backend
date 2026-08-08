import mongoose from 'mongoose';

const deletedMessageSchema = new mongoose.Schema(
  {
    originalMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
      unique: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    senderName: { type: String, default: '' },
    deletedById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    deletedByName: { type: String, default: '' },
    deletedAt: { type: Date, required: true, default: Date.now, index: true },
    deletedDate: { type: String, required: true },
    messageText: { type: String, default: '' },
    clientId: { type: String },
    attachment: { type: mongoose.Schema.Types.Mixed, default: undefined },
    replyTo: { type: mongoose.Schema.Types.Mixed, default: undefined },
    status: { type: String },
    originalCreatedAt: { type: Date },
    originalUpdatedAt: { type: Date },
    originalMessage: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    collection: 'DeletedMessages',
    timestamps: true,
  }
);

export const DeletedMessage = mongoose.model('DeletedMessage', deletedMessageSchema);
