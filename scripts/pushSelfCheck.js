/**
 * Self-check for the two pure helpers in pushService that fail silently when broken:
 * a service account that will not parse disables push, and a non-string data value
 * makes FCM reject the whole message. Run with: node scripts/pushSelfCheck.js
 */
import assert from 'assert';
import { readServiceAccount, stringifyData } from '../src/services/pushService.js';

const serviceAccount = { type: 'service_account', project_id: 'wave-test' };
const rawJson = JSON.stringify(serviceAccount);

// Raw JSON, base64, and whitespace-padded raw JSON must all parse.
process.env.FIREBASE_SERVICE_ACCOUNT = rawJson;
assert.deepStrictEqual(readServiceAccount(), serviceAccount, 'raw JSON service account');

process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(rawJson, 'utf8').toString('base64');
assert.deepStrictEqual(readServiceAccount(), serviceAccount, 'base64 service account');

process.env.FIREBASE_SERVICE_ACCOUNT = `\n  ${rawJson}  \n`;
assert.deepStrictEqual(readServiceAccount(), serviceAccount, 'padded raw JSON service account');

process.env.FIREBASE_SERVICE_ACCOUNT = '';
assert.strictEqual(readServiceAccount(), null, 'missing service account returns null');

// Every FCM data value must be a string; null/undefined keys must be dropped entirely.
const data = stringifyData({
  conversationId: 42,
  ringing: true,
  missing: null,
  absent: undefined,
  url: '/',
});
assert.deepStrictEqual(data, { conversationId: '42', ringing: 'true', url: '/' });
assert.ok(
  Object.values(data).every((value) => typeof value === 'string'),
  'all FCM data values must be strings'
);
assert.deepStrictEqual(stringifyData(), {}, 'no data yields an empty object');

console.log('✅ pushService self-check passed');
