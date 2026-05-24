import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendTriggerLog, listTriggerLogs } from '../src/services/trigger-log-store.js';

describe('trigger-log-store', () => {
  it('appends newest-first trigger log entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'trg_1', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_2', connectorId: 'conn_b', action: 'failed', status: 'error', errorCode: 'rate_limited', createdAt: '2026-05-24T00:01:00.000Z' }, dir);
    expect(listTriggerLogs({ limit: 10 }, dir).map(x => x.triggerId)).toEqual(['trg_2', 'trg_1']);
    expect(listTriggerLogs({ connectorId: 'conn_a' }, dir).map(x => x.triggerId)).toEqual(['trg_1']);
  });
});
