/**
 * Self-check for the two pure helpers in pushService that fail silently when broken:
 * a service account that will not parse disables push, and a non-string data value
 * makes FCM reject the whole message. Run with: node scripts/pushSelfCheck.js
 */
import assert from 'assert';
import { readServiceAccount, stringifyData, webpushLink } from '../src/services/pushService.js';
import { hasVisibleClient } from '../src/services/messageService.js';

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

// FCM rejects the whole message when webpush fcmOptions.link is not absolute HTTPS,
// so anything but https must yield '' and be left off the message entirely.
assert.strictEqual(
  webpushLink('/', 'https://wave.example.com'),
  'https://wave.example.com/',
  'https base yields an absolute link'
);
assert.strictEqual(
  webpushLink('/', 'http://localhost:3000'),
  '',
  'http base must not produce a link'
);
assert.strictEqual(webpushLink('/', ''), '', 'unset base produces no link');
assert.strictEqual(webpushLink('/', 'not a url'), '', 'unparseable base produces no link');

// The push gate. Getting this wrong is silent in both directions: too strict and a
// backgrounded PWA never hears anything, too loose and a user reading the chat gets
// a duplicate notification.
function fakeIo(sockets) {
  return {
    sockets: {
      adapter: { rooms: new Map([['user:u1', new Set(sockets.map((s) => s.id))]]) },
      sockets: new Map(sockets.map((s) => [s.id, s])),
    },
  };
}
const visible = { id: 'a', data: { isVisible: true } };
const hidden = { id: 'b', data: { isVisible: false } };
const legacy = { id: 'c', data: {} };

assert.strictEqual(hasVisibleClient(fakeIo([]), 'u1'), false, 'no socket is not visible');
assert.strictEqual(hasVisibleClient(fakeIo([visible]), 'u1'), true, 'visible tab suppresses push');
assert.strictEqual(
  hasVisibleClient(fakeIo([hidden]), 'u1'),
  false,
  'backgrounded PWA must still get a push'
);
assert.strictEqual(
  hasVisibleClient(fakeIo([hidden, visible]), 'u1'),
  true,
  'one visible device among hidden ones suppresses push'
);
assert.strictEqual(
  hasVisibleClient(fakeIo([legacy]), 'u1'),
  true,
  'a client that never reports visibility is assumed visible'
);
assert.strictEqual(hasVisibleClient(undefined, 'u1'), false, 'no io is not visible');
assert.strictEqual(hasVisibleClient(fakeIo([visible]), 'u2'), false, 'other user has no room');

console.log('✅ pushService self-check passed');
