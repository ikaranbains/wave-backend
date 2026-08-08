import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientId: { type: String, trim: true, maxlength: 80 },
    text: { type: String, default: '' },
    attachment: {
      type: { type: String, enum: ['image', 'video', 'audio', 'file'] },
      url: { type: String },
      name: { type: String },
      size: { type: String },
      bytes: { type: Number },
      mimeType: { type: String },
      publicId: { type: String },
      resourceType: { type: String },
    },
    replyTo: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    isDeleted: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  },
  { timestamps: true }
);

messageSchema.index(
  { senderId: 1, clientId: 1 },
  { unique: true, sparse: true }
);

export const Message = mongoose.model('Message', messageSchema);
