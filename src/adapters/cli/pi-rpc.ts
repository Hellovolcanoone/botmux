import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { buildBotmuxShellHints } from './shared-hints.js';
import { t } from '../../i18n/index.js';
import { encodePiRunnerInput, decodePiRunnerOutput, type PiRunnerOutputMessage } from '../../pi-runner-protocol.js';

let nextTurnSeq = 0;

export function nextPiRunnerTurnId(): string {
  nextTurnSeq += 1;
  return `pi-${process.pid}-${nextTurnSeq}`;
}

function botmuxPiSkillsDir(): string {
  return join(process.env.SESSION_DATA_DIR ?? join(process.env.HOME ?? '.', '.botmux', 'data'), 'pi-skills');
}

function botmuxPiSessionDir(): string {
  return join(process.env.SESSION_DATA_DIR ?? join(process.env.HOME ?? '.', '.botmux', 'data'), 'pi-sessions');
}

function runnerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pi-runner.js');
}

function appendSystemPrompt(botName?: string, botOpenId?: string, locale?: import('../../i18n/index.js').Locale): string {
  const unknown = t('ai.identity.unknown', undefined, locale);
  const identityBlock = botName || botOpenId
    ? [
        '',
        '<identity>',
        `  <name>${botName ?? unknown}</name>`,
        `  <open_id>${botOpenId ?? unknown}</open_id>`,
        `  <routing_rules>${t('ai.identity.short_routing', undefined, locale)}</routing_rules>`,
        '</identity>',
      ]
    : [];
  return [
    '<botmux_routing>',
    ...buildBotmuxShellHints(locale),
    '</botmux_routing>',
    ...identityBlock,
  ].join('\n');
}

export function sendPiRunnerMessage(pty: PtyHandle, content: string, type: 'prompt' | 'raw_command' = 'prompt'): string {
  const id = nextPiRunnerTurnId();
  pty.write(encodePiRunnerInput({ id, type, content }) + '\n');
  return id;
}

/** Adapter for Pi coding-agent through a botmux-owned RPC runner. */
export function createPiRpcAdapter(pathOverride?: string): CliAdapter {
  const piBin = resolveCommand(pathOverride ?? 'pi');
  const skillsDir = botmuxPiSkillsDir();
  const sessionDir = botmuxPiSessionDir();

  return {
    id: 'pi-rpc',
    resolvedBin: process.execPath,

    buildArgs({ sessionId, botName, botOpenId, locale }) {
      return [
        runnerPath(),
        '--pi-bin', piBin,
        '--',
        '--session-id', sessionId,
        '--session-dir', sessionDir,
        '--tools', 'read,bash,edit,write,grep,find,ls',
        '--append-system-prompt', appendSystemPrompt(botName, botOpenId, locale),
        '--no-skills',
        '--skill', skillsDir,
      ];
    },

    versionCommand() {
      return { bin: piBin, args: ['--version'] };
    },

    buildResumeCommand({ sessionId }) {
      return `pi --session-id ${sessionId} --session-dir ${sessionDir}`;
    },

    passesInitialPromptViaArgs: false,
    injectsSessionContext: true,
    supportsTypeAhead: true,

    async writeInput(pty: PtyHandle, content: string) {
      sendPiRunnerMessage(pty, content, 'prompt');
      return { submitted: true };
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: [],
    altScreen: false,
    skillsDir,
  };
}

export { decodePiRunnerOutput, type PiRunnerOutputMessage };
export const create = createPiRpcAdapter;
