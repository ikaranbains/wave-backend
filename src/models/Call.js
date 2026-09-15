import mongoose from 'mongoose';

/**
 * A call's lifecycle, persisted.
 *
 * The socket layer keeps an in-memory map for ring timeouts and fan-out, but
 * that map dies with the process — and a server restart mid-call used to lose
 * the call entirely, so it never got written into the conversation. This
 * collection is the source of truth for "did this call get logged yet".
 */
const callSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    callerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    type: { type: String, enum: ['voice', 'video'], default: 'voice' },
    status: {
      type: String,
      enum: ['ringing', 'accepted', 'ended'],
      default: 'ringing',
      index: true,
    },
    acceptedAt: { type: Date },
    endedAt: { type: Date },
    outcome: {
      type: String,
      enum: ['completed', 'missed', 'declined', 'cancelled'],
    },
    // Set once the chat entry exists, so a retry can never write a second one.
    loggedMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);

// Call history is find({ participantIds }).sort({ createdAt: -1 }). The caller is
// always in participantIds, so this one multikey compound index serves the whole
// query — match and sort — instead of scanning the collection and sorting in memory.
callSchema.index({ participantIds: 1, createdAt: -1 });

export const Call = mongoose.model('Call', callSchema);
