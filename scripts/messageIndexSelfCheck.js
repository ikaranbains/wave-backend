/**
 * Self-check for the {senderId, clientId} unique index.
 *
 * Two things must hold at once, and the old sparse index broke the first:
 *   1. Many messages from one sender with NO clientId must all insert.
 *   2. Two messages from one sender with the SAME clientId must still be rejected,
 *      because that is what keeps the offline outbox replay idempotent.
 *
 * Writes only under a throwaway conversationId and deletes everything it inserts.
 * Run with: node scripts/messageIndexSelfCheck.js
 */
import assert from 'assert';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { Message } from '../src/models/Message.js';
import { syncModelIndexes } from '../src/config/syncIndexes.js';

const conversationId = new mongoose.Types.ObjectId();
const senderId = new mongoose.Types.ObjectId();

function newMessage(extra) {
  return { conversationId, senderId, text: 'x', ...extra };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await syncModelIndexes();

  try {
    // The index must be partial, not sparse — sparse is what caused the bug.
    const indexes = await Message.collection.indexes();
    const idempotency = indexes.find((index) => index.name === 'senderId_1_clientId_1');
    assert.ok(idempotency, 'senderId_1_clientId_1 index is missing');
    assert.ok(idempotency.unique, 'idempotency index must stay unique');
    assert.ok(
      idempotency.partialFilterExpression,
      'index must be partial, not sparse — sparse still indexes a missing clientId as null'
    );
    assert.ok(!idempotency.sparse, 'the old sparse index was not replaced');

    // 1. Three messages with no clientId at all. The old index rejected the second.
    await Message.create(newMessage({}));
    await Message.create(newMessage({}));
    await Message.create(newMessage({ clientId: undefined }));
    assert.strictEqual(
      await Message.countDocuments({ conversationId }),
      3,
      'messages without a clientId must not collide'
    );

    // 2. A duplicate clientId must still be rejected, or outbox replay would duplicate.
    await Message.create(newMessage({ clientId: 'outbox-1' }));
    await assert.rejects(
      () => Message.create(newMessage({ clientId: 'outbox-1' })),
      (error) => error.code === 11000,
      'a repeated clientId must still be rejected as a duplicate'
    );

    // 3. A different clientId from the same sender is a different message.
    await Message.create(newMessage({ clientId: 'outbox-2' }));
    assert.strictEqual(await Message.countDocuments({ conversationId }), 5);

    console.log('✅ message index self-check passed (null clientIds coexist, duplicates rejected)');
  } finally {
    await Message.deleteMany({ conversationId });
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error('❌', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
