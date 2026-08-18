import { Call } from '../models/Call.js';
import { Conversation } from '../models/Conversation.js';
import { DeviceToken } from '../models/DeviceToken.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';

const models = [User, Conversation, Message, Call, DeviceToken];

/**
 * Bring every collection's indexes in line with its schema: create what is new, drop
 * what the schema no longer declares. The schema is the single source of truth, so an
 * index added by hand outside it will be removed.
 *
 * Never fatal — a failure here degrades query speed, it does not break the app.
 */
export async function syncModelIndexes() {
  const results = await Promise.allSettled(models.map((model) => model.syncIndexes()));

  results.forEach((result, index) => {
    const name = models[index].modelName;
    if (result.status === 'rejected') {
      console.warn(`⚠️ Could not sync ${name} indexes:`, result.reason?.message);
      return;
    }
    // syncIndexes resolves with the names of the indexes it dropped.
    const dropped = result.value || [];
    if (dropped.length > 0) console.log(`🧹 Dropped stale ${name} indexes:`, dropped.join(', '));
  });
}
