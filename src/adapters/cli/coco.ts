import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `coco --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,
    // `⏵⏵` only shows when CoCo runs with --yolo (bypass permissions). Adopted
    // CoCo processes started by the user manually usually don't have that flag,
    // so the status bar shows just the model badge `⬡ <model>` instead. Match
    // either — without this, idle detection never fires for adopt mode and the
    // transcript bridge never drains.
    readyPattern: /⏵⏵|⬡/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createCocoAdapter;
