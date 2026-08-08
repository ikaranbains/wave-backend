import webpush from 'web-push';
import { PushSubscription } from '../models/PushSubscription.js';

// ES module imports are evaluated before index.js calls dotenv.config(), so VAPID
// details are read lazily on first use rather than at import time.
let pushConfigured = null;

function ensureConfigured() {
  if (pushConfigured !== null) return pushConfigured;

  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@wave.local';

  if (publicKey && privateKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    pushConfigured = true;
  } else {
    console.warn(
      '⚠️ Web push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable notifications.'
    );
    pushConfigured = false;
  }

  return pushConfigured;
}

export function isPushConfigured() {
  return ensureConfigured();
}

export function getPushPublicKey() {
  return ensureConfigured() ? process.env.VAPID_PUBLIC_KEY || '' : '';
}

export async function saveSubscription(userId, subscription, userAgent = '') {
  const { endpoint, keys, expirationTime } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid push subscription payload');
  }

  return PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      $set: {
        userId,
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        expirationTime: expirationTime ? new Date(expirationTime) : null,
        userAgent: String(userAgent).slice(0, 300),
        lastUsedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function removeSubscription(userId, endpoint) {
  if (!endpoint) return { deletedCount: 0 };
  return PushSubscription.deleteOne({ endpoint, userId });
}

export async function removeAllSubscriptionsForUser(userId) {
  return PushSubscription.deleteMany({ userId });
}

/**
 * Deliver a notification payload to every device registered for a user.
 * Subscriptions rejected by the push service as gone (404/410) are pruned.
 */
export async function sendPushToUser(userId, payload) {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 };

  const subscriptions = await PushSubscription.find({ userId });
  if (subscriptions.length === 0) return { sent: 0, pruned: 0 };

  const serializedPayload = JSON.stringify(payload);
  const staleEndpoints = [];
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.keys.p256dh,
              auth: subscription.keys.auth,
            },
          },
          serializedPayload,
          { TTL: 60 * 60, urgency: 'high' }
        );
        sent += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          staleEndpoints.push(subscription.endpoint);
        } else {
          console.error('Web push delivery failed:', error.statusCode, error.body || error.message);
        }
      }
    })
  );

  if (staleEndpoints.length > 0) {
    await PushSubscription.deleteMany({ endpoint: { $in: staleEndpoints } });
  }

  return { sent, pruned: staleEndpoints.length };
}
