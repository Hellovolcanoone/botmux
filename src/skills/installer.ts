import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { BUILTIN_SKILLS, RETIRED_SKILL_NAMES, ASK_SKILL, ASK_SKILL_NAME } from './definitions.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * 条件管理 `botmux-ask` skill —— hook 优先 + 非 hook CLI 兜底策略。
 *
 * - `install=false`（CLI 支持 hook 接管 askUserQuestion）：删除该 skill，避免
 *   skill 与 hook 双重弹卡 / 抢工具。
 * - `install=true`（CLI 无 hook 接管能力）：写入该 skill，让 agent 至少能用
 *   `botmux ask buttons` 把选择题引到飞书（不如 hook 可靠，但有得用）。
 *
 * 幂等：install 时内容相同则跳过；remove 时不存在则跳过。
 */
export function ensureAskSkill(cliId: string, skillsDir: string | undefined, install: boolean): void {
  if (!skillsDir) return;
  const skillDir = join(expandHome(skillsDir), ASK_SKILL_NAME);
  const skillFile = join(skillDir, 'SKILL.md');
  try {
    if (install) {
      if (existsSync(skillFile) && readFileSync(skillFile, 'utf-8') === ASK_SKILL) return;
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, ASK_SKILL, 'utf-8');
      logger.info(`[skills] Installed ${ASK_SKILL_NAME} (无 hook 接管，兜底) for ${cliId} → ${skillFile}`);
    } else {
      if (!existsSync(skillDir)) return;
      rmSync(skillDir, { recursive: true, force: true });
      logger.info(`[skills] Removed ${ASK_SKILL_NAME} (hook 已接管) for ${cliId}`);
    }
  } catch (err: any) {
    logger.warn(`[skills] ensureAskSkill(${install}) failed for ${cliId}: ${err.message}`);
  }
}

/**
 * Install (or refresh) the built-in skill library into the given CLI's skills
 * directory. Idempotent — only writes when content differs.
 *
 * Each skill becomes {skillsDir}/<name>/SKILL.md. Sub-directory layout
 * matches Claude Code / Gemini / OpenCode convention. Retired skills (renamed
 * or removed in a later version) are deleted from the directory so the CLI
 * doesn't keep surfacing stale entries alongside their replacements.
 */
export function ensureSkills(cliId: string, skillsDir: string | undefined): void {
  if (!skillsDir) return;
  const dir = expandHome(skillsDir);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  for (const skill of BUILTIN_SKILLS) {
    const skillDir = join(dir, skill.name);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      if (existsSync(skillFile)) {
        const current = readFileSync(skillFile, 'utf-8');
        if (current === skill.content) continue;
      }
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, skill.content, 'utf-8');
      logger.info(`[skills] Installed ${skill.name} for ${cliId} → ${skillFile}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to install ${skill.name} for ${cliId}: ${err.message}`);
    }
  }

  // Clean up retired skill directories (e.g. botmux-thread-messages → botmux-history).
  for (const retired of RETIRED_SKILL_NAMES) {
    const retiredDir = join(dir, retired);
    if (!existsSync(retiredDir)) continue;
    try {
      rmSync(retiredDir, { recursive: true, force: true });
      logger.info(`[skills] Removed retired skill ${retired} for ${cliId}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to remove retired skill ${retired} for ${cliId}: ${err.message}`);
    }
  }
}
