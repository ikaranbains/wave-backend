import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    avatar: {
      type: String,
      default: '',
    },
    phone: { type: String },
    status: { type: String, enum: ['online', 'offline', 'away'], default: 'online' },
    lastSeen: { type: String, default: 'Active now' },
    statusMessage: { type: String, default: '', maxlength: 160 },
    preferences: {
      notificationsEnabled: { type: Boolean, default: true },
      soundEnabled: { type: Boolean, default: true },
      showOnlineStatus: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
