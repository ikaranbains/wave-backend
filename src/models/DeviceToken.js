import mongoose from 'mongoose';

/**
 * One row per browser/device registered with Firebase Cloud Messaging. The token is
 * issued by the Firebase JS SDK on the client and rotates, so it is the unique key
 * and rows are pruned whenever FCM reports a token as no longer registered.
 */
const deviceTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: { type: String, required: true, unique: true },
    userAgent: { type: String, default: '', maxlength: 300 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const DeviceToken = mongoose.model('DeviceToken', deviceTokenSchema);
