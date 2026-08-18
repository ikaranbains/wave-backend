import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    lastMessage: { type: String, default: 'Conversation started' },
    unreadCounts: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

// The inbox query is Conversation.find({ participants }).sort({ updatedAt: -1 }).
// A multikey compound index serves both halves, so neither a collection scan nor an
// in-memory sort is needed on every conversation list load.
conversationSchema.index({ participants: 1, updatedAt: -1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
