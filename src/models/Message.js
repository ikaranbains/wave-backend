import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
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
    // Set on system messages that record a finished call, so the thread keeps a
    // history of calls the way it keeps a history of messages.
    callEvent: {
      type: {
        type: String,
        enum: ['voice', 'video'],
      },
      outcome: {
        type: String,
        enum: ['completed', 'missed', 'declined', 'cancelled'],
      },
      durationSeconds: { type: Number, min: 0 },
    },
    isDeleted: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  },
  { timestamps: true }
);

// Partial, not sparse. A compound sparse index skips a document only when EVERY
// indexed field is missing, and senderId is always set — so a missing clientId was
// still indexed as null, and the second such message from one sender died on a
// duplicate key. A partial index leaves those documents out of the index entirely
// while still enforcing idempotency for the clientIds that do exist.
messageSchema.index(
  { senderId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

// Thread history pages with find({ conversationId }).sort({ createdAt }), and the
// pagination cursor tie-breaks on _id. This covers the match, the sort and the
// cursor, so no in-memory sort is needed. Its conversationId prefix also replaces
// the standalone conversationId index.
messageSchema.index({ conversationId: 1, createdAt: 1, _id: 1 });

export const Message = mongoose.model('Message', messageSchema);
