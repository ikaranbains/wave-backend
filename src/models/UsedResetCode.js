import mongoose from 'mongoose';

/**
 * One row per backup code that has already reset a password. The unique index is the
 * lock: inserting is the act of claiming a code, so two requests racing with the same
 * code cannot both succeed. Codes are stored hashed — a dump of this collection must
 * not hand over the codes that are still unused.
 */
const usedResetCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

export const UsedResetCode = mongoose.model('UsedResetCode', usedResetCodeSchema);
