/**
 * Dependency bootstrap. Called from `botmux start` and `botmux restart` so
 * a fresh machine that just `npm i -g botmux`'d gets tmux + screenshot fonts
 * provisioned without manual setup.
 *
 * - tmux is required: a failed install throws so cli.ts can exit non-zero.
 * - fonts are nice-to-have: failures only print a warning.
 * - herdr is on-demand: only runs when at least one bot in bots.json has
 *   `backendType: 'herdr'`. Avoids dragging an extra binary onto every host.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectPlatform } from './detect-platform.js';
import { ensureTmux, type TmuxResult } from './ensure-tmux.js';
import { ensureFonts, type FontResult } from './ensure-fonts.js';
import { ensureHerdr, type HerdrResult } from './ensure-herdr.js';
import { ensureHerdrIntegrations, type HerdrIntegrationResult } from './ensure-herdr-integrations.js';
import type { CliId } from '../adapters/cli/types.js';

export interface DependenciesReport {
  tmux: TmuxResult;
  fonts: FontResult;
  herdr?: HerdrResult;
  herdrIntegrations?: HerdrIntegrationResult;
}

export { botmuxFontDir } from './ensure-fonts.js';

const BOTS_JSON_FILE = join(homedir(), '.botmux', 'bots.json');

/**
 * Read bots.json directly (no parser, no validation) to find which CLIs
 * have herdr backend selected. We deliberately bypass parseBotConfigsJson
 * to avoid pulling the full bot-config-editor module (and its CLI deps)
 * into the bootstrap path. Best-effort: any read/parse failure → empty list,
 * herdr install will simply skip.
 */
function herdrCliIds(): CliId[] {
  if (!existsSync(BOTS_JSON_FILE)) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(BOTS_JSON_FILE, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = new Set<CliId>();
  for (const bot of parsed) {
    if (!bot || typeof bot !== 'object') continue;
    if (bot.backendType !== 'herdr') continue;
    const cli = (bot.cliId ?? 'claude-code') as CliId;
    out.add(cli);
  }
  return [...out];
}

export async function ensureDependencies(): Promise<DependenciesReport> {
  const platform = detectPlatform();

  // tmux: nice-to-have (enables /adopt + multi-pane Web terminal). Daemon
  // still works on PTY backend without it, so failure is a warning, not fatal.
  const tmux = await ensureTmux(platform);
  if (tmux.installed) {
    if (!tmux.freshInstall) console.log(`✓ tmux ${tmux.version} (existing)`);
  } else {
    console.warn('');
    console.warn('⚠️  tmux 不可用，已退回到 PTY backend');
    console.warn(`    原因：${tmux.reason ?? '未知'}`);
    if (tmux.manualCommand) console.warn(`    手动尝试：${tmux.manualCommand}`);
    console.warn('    影响：/adopt（接管已有 CLI 会话）和多人 Web 终端不可用；常规对话不受影响。');
    console.warn('');
  }

  // Fonts second — best-effort.
  const fonts = await ensureFonts(platform);
  if (fonts.failed.length === 0) {
    if (platform.os === 'darwin') {
      console.log('✓ 字体: 系统字体已就绪 (macOS)');
    } else {
      console.log(`✓ 字体: ${fonts.ready.join(' / ')} 已就绪`);
    }
  } else {
    console.warn(`⚠️  字体部分缺失: ${fonts.failed.join(' / ')} —— 飞书截图中相关字符可能渲染为方块`);
  }

  // herdr: on-demand only. We won't pull it onto hosts that don't use it.
  const herdrCandidates = herdrCliIds();
  let herdr: HerdrResult | undefined;
  let herdrIntegrations: HerdrIntegrationResult | undefined;
  if (herdrCandidates.length > 0) {
    herdr = await ensureHerdr();
    if (herdr.installed) {
      if (!herdr.freshInstall) console.log(`✓ herdr ${herdr.version} (existing)`);
      // Only attempt integration install when herdr itself is on PATH —
      // otherwise `herdr integration install` would just spam ENOENT.
      herdrIntegrations = await ensureHerdrIntegrations(herdrCandidates);
      reportHerdrIntegrations(herdrIntegrations);
    } else {
      console.warn('');
      console.warn('⚠️  herdr 安装失败，使用 herdr backend 的 bot 将无法启动');
      console.warn(`    原因：${herdr.reason ?? '未知'}`);
      if (herdr.manualCommand) console.warn(`    手动尝试：${herdr.manualCommand}`);
      console.warn('    临时方案：把对应 bot 的 backendType 改回 "tmux" 或 "pty"');
      console.warn('');
    }
  }

  return { tmux, fonts, herdr, herdrIntegrations };
}

function reportHerdrIntegrations(r: HerdrIntegrationResult): void {
  if (r.attempted.length === 0 && r.unsupportedCliIds.length === 0) return;
  if (r.installed.length > 0) console.log(`✓ herdr integrations 已安装: ${r.installed.join(' / ')}`);
  if (r.alreadyInstalled.length > 0) console.log(`✓ herdr integrations (existing): ${r.alreadyInstalled.join(' / ')}`);
  for (const f of r.failed) {
    console.warn(`⚠️  herdr integration 安装失败: ${f.name} — ${f.reason}`);
    console.warn(`    手动尝试：herdr integration install ${f.name}`);
  }
  if (r.unsupportedCliIds.length > 0) {
    console.warn(
      `⚠️  以下 CLI 暂无官方 herdr integration（herdr 仍可用，但仅靠屏幕启发式检测状态）: ${r.unsupportedCliIds.join(', ')}`,
    );
  }
}
