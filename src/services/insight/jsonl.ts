import { readFileSync, statSync } from 'node:fs';

export interface JsonlReadResult {
  entries: any[];
  asOf?: string;
  partial: boolean;
}

/** Full-file JSONL reader for pull-mode insight.
 *  It commits only complete newline-terminated rows and discards the trailing
 *  partial row, matching the live transcript bridge's half-write tolerance. */
export function readCompleteJsonlObjects(path: string): JsonlReadResult {
  const st = statSync(path);
  const raw = readFileSync(path, 'utf-8');
  const lastNl = raw.lastIndexOf('\n');
  const partial = raw.length > 0 && lastNl !== raw.length - 1;
  const committed = lastNl >= 0 ? raw.slice(0, lastNl) : '';
  const entries: any[] = [];
  for (const line of committed.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // Skip malformed committed rows defensively; insight is advisory.
    }
  }
  return { entries, asOf: new Date(st.mtimeMs).toISOString(), partial };
}
