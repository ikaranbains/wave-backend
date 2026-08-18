/**
 * Self-check for thread-history pagination against the real database.
 *
 * Covers the two things that fail silently: a page boundary that drops or repeats a
 * message, and a query that stops using the compound index and sorts in memory.
 * Writes only under a throwaway conversationId and deletes everything it inserts.
 *
 * Run with: node scripts/messagePaginationSelfCheck.js
 */
import assert from 'assert';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { Conversation } from '../src/models/Conversation.js';
import { Message } from '../src/models/Message.js';
import { buildMessagePageFilter } from '../src/routes/chatRoutes.js';

const PAGE_SIZE = 10;
const TOTAL = 25;
const conversationId = new mongoose.Types.ObjectId();
const senderId = new mongoose.Types.ObjectId();

/** Mirrors the route: newest-first with a limit, then reversed for the client. */
async function fetchPage({ before, beforeId }) {
  const filter = buildMessagePageFilter({ conversationId, before, beforeId });
  const page = await Message.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(PAGE_SIZE + 1)
    .lean();
  const hasMore = page.length > PAGE_SIZE;
  if (hasMore) page.pop();
  return { messages: page.reverse(), hasMore };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([Message.syncIndexes(), Conversation.syncIndexes()]);

  try {
    // Messages 9, 10 and 11 share one timestamp, straddling the first page boundary —
    // exactly the case a createdAt-only cursor gets wrong.
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();
    const collided = base + 9 * 1000;
    const docs = Array.from({ length: TOTAL }, (_, index) => ({
      conversationId,
      senderId,
      // Distinct clientId per doc: the {senderId, clientId} index is compound-sparse,
      // so it still indexes a null clientId and a second null from one sender collides.
      clientId: `selfcheck-${conversationId}-${index}`,
      text: `message ${index}`,
      createdAt: new Date(index >= 9 && index <= 11 ? collided : base + index * 1000),
      updatedAt: new Date(base + index * 1000),
    }));
    await Message.insertMany(docs, { ordered: true });

    // Page backwards from newest to oldest, the way the client does.
    const seen = [];
    let cursor = {};
    let pages = 0;
    for (;;) {
      const { messages, hasMore } = await fetchPage(cursor);
      pages += 1;
      assert.ok(pages <= 10, 'pagination did not terminate');

      // Each page must itself be oldest-first.
      const times = messages.map((m) => m.createdAt.getTime());
      assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), 'page not ascending');

      seen.unshift(...messages);
      if (!hasMore) break;

      const oldest = messages[0];
      cursor = { before: oldest.createdAt.toISOString(), beforeId: String(oldest._id) };
    }

    const ids = seen.map((m) => String(m._id));
    assert.strictEqual(new Set(ids).size, ids.length, 'a message was returned on two pages');
    assert.strictEqual(seen.length, TOTAL, `expected ${TOTAL} messages, got ${seen.length}`);
    assert.strictEqual(pages, Math.ceil(TOTAL / PAGE_SIZE), 'unexpected page count');

    // Full-set order must be ascending even across the colliding timestamps.
    const allTimes = seen.map((m) => m.createdAt.getTime());
    assert.deepStrictEqual(allTimes, [...allTimes].sort((a, b) => a - b), 'full order not ascending');

    // The compound index must serve both the match and the sort.
    const explain = await Message.find({ conversationId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(PAGE_SIZE)
      .explain('queryPlanner');
    const plan = JSON.stringify(explain.queryPlanner.winningPlan);
    assert.ok(plan.includes('IXSCAN'), 'thread history is not using an index: ' + plan);
    assert.ok(
      !plan.includes('"stage":"SORT"'),
      'thread history is still sorting in memory: ' + plan
    );

    // The inbox query must use the new participants/updatedAt index, not a scan.
    const inbox = await Conversation.find({ participants: senderId })
      .sort({ updatedAt: -1 })
      .explain('queryPlanner');
    const inboxPlan = JSON.stringify(inbox.queryPlanner.winningPlan);
    assert.ok(inboxPlan.includes('IXSCAN'), 'inbox query is not using an index: ' + inboxPlan);
    assert.ok(
      !inboxPlan.includes('"stage":"SORT"'),
      'inbox query is still sorting in memory: ' + inboxPlan
    );

    console.log(`✅ pagination self-check passed (${TOTAL} messages over ${pages} pages, indexes used)`);
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
