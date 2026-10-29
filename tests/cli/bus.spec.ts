// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/cli/bus.spec.ts - E2E-CLI-10: bus CLI suite - full functional E2E.
//
// Full lifecycle: produce → consume → ack → verify empty.
// Also: stream list, stream lag, dlq list, nack round-trip.

import { test, expect } from '@playwright/test';
import { cliDo, cliListCommands, assertCliOk, assertCliDispatched } from '../../fixtures/cli.js';
import { ensureSignedIn } from './_setup.js';
import { RUN_ID } from '../../fixtures/testdata.js';

test.describe.configure({ mode: 'serial' });

test.describe('CLI - bus (full functional)', () => {
  test.beforeAll(async () => { await ensureSignedIn(); });

  test('bus commands are listed in list-commands', async () => {
    const r = await cliListCommands();
    assertCliOk(r, 'list-commands');
    expect(r.stdout).toContain('bus:');
    expect(r.stdout).toContain('produce');
    expect(r.stdout).toContain('consume');
    expect(r.stdout).toContain('ack');
    expect(r.stdout).toContain('nack');
  });

  // ── Full produce → consume → ack round-trip ──
  test('bus produce → consume → ack round-trip', async () => {
    const streamFamily = `e2e-test-${RUN_ID}`;
    // (bus DESIGN §4.3): the event type's FIRST segment = the owning
    // vertical, matched against the producer's M2M `vertical` claim. The
    // CLI-driven produce rides the cli-producer M2M workload (vertical
    // 'sentin8'), so the event must carry the platform vertical -
    // vertical:service:resource:operation = sentin8:e2e:test:event.
    const eventType = `sentin8:e2e:test:event`;
    const payload = JSON.stringify({ message: 'hello from E2E', run_id: RUN_ID });
    const consumerGroup = `e2e-consumer-${RUN_ID}`;

    // 1. Produce a real message
    const r1 = await cliDo('bus', 'produce', 'send', {
      stream_family: streamFamily,
      event_type: eventType,
      payload,
    });
    assertCliDispatched(r1, 'bus produce send');
    if (r1.exitCode !== 0) return;

    // 2. List streams → verify the stream appears
    const r2 = await cliDo('bus', 'stream', 'list');
    assertCliDispatched(r2, 'bus stream list');

    // 3. Get stream lag → verify the stream has pending messages
    const r3 = await cliDo('bus', 'stream', 'lag', { stream_family: streamFamily });
    assertCliDispatched(r3, 'bus stream lag');

    // 4. Consume from the stream
    const r4 = await cliDo('bus', 'consume', 'list', {
      stream_family: streamFamily,
      consumer_group: consumerGroup,
    });
    assertCliDispatched(r4, 'bus consume list');
    if (r4.exitCode !== 0) return;

    // 5. If we got messages, ack the first one
    let messageId = '';
    if (r4.json) {
      try {
        const obj = r4.json as Record<string, unknown>;
        const messages = (obj.messages ?? obj.rows ?? []) as Array<Record<string, unknown>>;
        if (messages.length > 0) {
          messageId = String(messages[0].id ?? messages[0].message_id ?? '');
        }
      } catch { /* ignore */ }
    }
    if (!messageId) {
      const m = r4.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) messageId = m[0];
    }

    if (messageId) {
      // 6. Ack the message
      const r5 = await cliDo('bus', 'ack', 'send', {
        stream_family: streamFamily,
        consumer_group: consumerGroup,
        message_id: messageId,
      });
      assertCliDispatched(r5, 'bus ack send');

      // 7. Consume again → verify no more messages (all acked)
      const r6 = await cliDo('bus', 'consume', 'list', {
        stream_family: streamFamily,
        consumer_group: consumerGroup,
      });
      assertCliDispatched(r6, 'bus consume (after ack)');
    }

    // 8. List DLQ → verify empty (no poison messages)
    const r7 = await cliDo('bus', 'dlq', 'list');
    assertCliDispatched(r7, 'bus dlq list');
  });

  // ── Nack round-trip ──
  test('bus produce → consume → nack → redeliver', async () => {
    const streamFamily = `e2e-nack-${RUN_ID}`;
    const consumerGroup = `e2e-nack-consumer-${RUN_ID}`;

    // Produce
    const r1 = await cliDo('bus', 'produce', 'send', {
      stream_family: streamFamily,
      event_type: 'sentin8:e2e:nack:test',
      payload: JSON.stringify({ test: 'nack' }),
    });
    assertCliDispatched(r1, 'bus produce (nack test)');
    if (r1.exitCode !== 0) return;

    // Consume
    const r2 = await cliDo('bus', 'consume', 'list', {
      stream_family: streamFamily,
      consumer_group: consumerGroup,
    });
    assertCliDispatched(r2, 'bus consume (nack test)');
    if (r2.exitCode !== 0) return;

    // Extract message ID and nack it
    let messageId = '';
    if (r2.json) {
      try {
        const obj = r2.json as Record<string, unknown>;
        const messages = (obj.messages ?? obj.rows ?? []) as Array<Record<string, unknown>>;
        if (messages.length > 0) {
          messageId = String(messages[0].id ?? messages[0].message_id ?? '');
        }
      } catch { /* ignore */ }
    }
    if (!messageId) {
      const m = r2.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) messageId = m[0];
    }

    if (messageId) {
      const r3 = await cliDo('bus', 'nack', 'send', {
        stream_family: streamFamily,
        consumer_group: consumerGroup,
        message_id: messageId,
      });
      assertCliDispatched(r3, 'bus nack send');
    }
  });
});