import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    lastMessage: { type: String, default: 'Conversation started' },
    unreadCounts: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

export const Conversation = mongoose.model('Conversation', conversationSchema);
