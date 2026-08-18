import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { DeviceToken } from '../models/DeviceToken.js';

// ES module imports are evaluated before index.js calls dotenv.config(), so Firebase
// credentials are read lazily on first use rather than at import time.
let messaging = null;
let pushConfigured = null;

/** Accepts the service account as raw JSON or base64 — hosts differ on what they allow in env. */
export function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;

  const decoded = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(decoded);
}

function ensureConfigured() {
  if (pushConfigured !== null) return pushConfigured;

  try {
    const serviceAccount = readServiceAccount();
    if (!serviceAccount) {
      console.warn(
        '⚠️ Push disabled: set FIREBASE_SERVICE_ACCOUNT to the service account JSON (raw or base64).'
      );
      pushConfigured = false;
      return pushConfigured;
    }

    const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
    messaging = getMessaging(app);
    pushConfigured = true;
  } catch (error) {
    console.error('⚠️ Push disabled: unable to initialize Firebase Admin:', error.message);
    pushConfigured = false;
  }

  return pushConfigured;
}

export function isPushConfigured() {
  return ensureConfigured();
}

/**
 * The Firebase "Web Push certificate" public key. The browser needs it for
 * getToken({ vapidKey }); the server never signs with it.
 */
export function getPushPublicKey() {
  return ensureConfigured() ? process.env.FIREBASE_VAPID_KEY || '' : '';
}

export async function saveToken(userId, token, userAgent = '') {
  if (typeof token !== 'string' || token.length < 20) {
    throw new Error('Invalid FCM registration token');
  }

  return DeviceToken.findOneAndUpdate(
    { token },
    {
      $set: {
        userId,
        token,
        userAgent: String(userAgent).slice(0, 300),
        lastUsedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function removeToken(userId, token) {
  if (!token) return { deletedCount: 0 };
  return DeviceToken.deleteOne({ token, userId });
}

/** FCM data values must all be strings; drop anything null/undefined. */
export function stringifyData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

// FCM rejects a multicast batch larger than 500 tokens.
const FCM_BATCH_SIZE = 500;

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Deliver a notification to every device registered for a user. Tokens FCM reports
 * as dead are pruned so a stale browser is not retried forever.
 *
 * @param {object} payload  { title, body, icon, badge, tag, url, data }
 * @param {object} options  { ttlSeconds, requireInteraction }
 */
export async function sendPushToUser(userId, payload, options = {}) {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 };

  const devices = await DeviceToken.find({ userId }).select('token');
  if (devices.length === 0) return { sent: 0, pruned: 0 };

  const { title, body, icon, badge, tag, url, data } = payload || {};
  const { ttlSeconds = 60 * 60, requireInteraction = false } = options;

  const notification = { title: title || 'Wave', body: body || '' };
  const message = {
    notification,
    data: stringifyData({ ...data, url: url || data?.url }),
    webpush: {
      headers: { Urgency: 'high', TTL: String(ttlSeconds) },
      notification: {
        ...notification,
        icon: icon || '/wave-192.png',
        badge: badge || '/wave-192.png',
        tag,
        renotify: Boolean(tag),
        requireInteraction,
      },
      // Absolute HTTPS URL required by FCM, so only set it when one is configured.
      ...(process.env.APP_BASE_URL
        ? { fcmOptions: { link: new URL(url || '/', process.env.APP_BASE_URL).toString() } }
        : {}),
    },
  };

  const tokens = devices.map((device) => device.token);
  const deadTokens = [];
  let sent = 0;

  for (let start = 0; start < tokens.length; start += FCM_BATCH_SIZE) {
    const batch = tokens.slice(start, start + FCM_BATCH_SIZE);
    let response;
    try {
      response = await messaging.sendEachForMulticast({ ...message, tokens: batch });
    } catch (error) {
      console.error('FCM multicast failed:', error.code || error.message);
      continue;
    }

    response.responses.forEach((result, index) => {
      if (result.success) {
        sent += 1;
        return;
      }
      const code = result.error?.code;
      if (DEAD_TOKEN_CODES.has(code)) {
        deadTokens.push(batch[index]);
      } else {
        console.error('FCM delivery failed:', code, result.error?.message);
      }
    });
  }

  if (deadTokens.length > 0) {
    await DeviceToken.deleteMany({ token: { $in: deadTokens } });
  }

  return { sent, pruned: deadTokens.length };
}
