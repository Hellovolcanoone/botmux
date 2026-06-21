import type { SafeTextPreview } from './types.js';

const DIRECT_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];

const KEY_VALUE_SECRET_PATTERNS: RegExp[] = [
  /\b([A-Za-z0-9_-]*(?:token|secret|key|password|passwd|pwd)[A-Za-z0-9_-]*)(=|:)([^\s&]+)/gi,
  /\b(BOTMUX_[A-Z0-9_]*|LARK_APP_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY)(=|:)([^\s&]+)/g,
  /\b(--?[A-Za-z0-9_-]*(?:token|secret|key|password|passwd|pwd)[A-Za-z0-9_-]*)\s+([^\s]+)/gi,
  /(https?:\/\/[^\s?]+)\?([^\s]+)/gi,
];

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function commandFromInput(input: unknown): string | undefined {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      const parsedCommand = commandFromInput(parsed);
      if (parsedCommand) return parsedCommand;
    } catch {
      // Plain shell command strings are valid inputs too.
    }
    return input;
  }
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return undefined;
}

export function safeTextPreview(value: unknown, max: number): SafeTextPreview | undefined {
  const raw = stringifyValue(value)?.replace(/\r\n?/g, '\n').replace(/\p{C}/gu, ch => ch === '\n' || ch === '\t' ? ch : '').trim();
  if (!raw) return undefined;
  let text = raw;
  for (const re of DIRECT_SECRET_PATTERNS) text = text.replace(re, '<redacted>');
  for (const re of KEY_VALUE_SECRET_PATTERNS) {
    text = text.replace(re, (_m, a, sepOrValue) => {
      if (typeof a === 'string' && a.startsWith('http')) return `${a}?<redacted>`;
      if (typeof a === 'string' && a.startsWith('-')) return `${a} <redacted>`;
      return `${a}${sepOrValue}<redacted>`;
    });
  }
  const truncated = text.length > max;
  return {
    text: truncated ? `${text.slice(0, Math.max(0, max - 1))}…` : text,
    truncated,
  };
}

export function safeCommandPreview(input: unknown): SafeTextPreview | undefined {
  return safeTextPreview(commandFromInput(input), 800);
}

export function safeOutputPreview(output: unknown): SafeTextPreview | undefined {
  return safeTextPreview(output, 2000);
}
