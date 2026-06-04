import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { logger } from './utils/logger.js';

type Backend = { id: string; url: string };
type Route = { chatId: string; backend: string };
type Config = {
  larkAppId: string;
  larkAppSecret: string;
  backends: Backend[];
  routes: Route[];
  defaultBackend: string;
  timeoutMs?: number;
};

type Ownership = { backend: string; status: 'received' | 'inflight' | 'delivered' | 'failed'; updatedAt: number };

const ownership = new Map<string, Ownership>();

function defaultBackend(config: Config): Backend {
  const backend = config.backends.find(b => b.id === config.defaultBackend) ?? config.backends[0];
  if (!backend) throw new Error('no backend configured');
  return backend;
}

function backendByOwner(config: Config, owner: Ownership | undefined, reason: string): Backend | undefined {
  if (!owner) return undefined;
  const backend = config.backends.find(b => b.id === owner.backend);
  if (!backend) logger.warn(`[gateway] ${reason} owner backend missing (${owner.backend}), falling back to default`);
  return backend;
}

function loadConfig(): Config {
  const path = process.env.BOTMUX_LARK_GATEWAY_CONFIG;
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  return {
    larkAppId: process.env.LARK_APP_ID ?? '',
    larkAppSecret: process.env.LARK_APP_SECRET ?? '',
    defaultBackend: process.env.BOTMUX_GATEWAY_DEFAULT_BACKEND ?? 'default',
    timeoutMs: Number(process.env.BOTMUX_GATEWAY_TIMEOUT_MS ?? 2500),
    backends: [{ id: process.env.BOTMUX_GATEWAY_DEFAULT_BACKEND ?? 'default', url: process.env.BOTMUX_GATEWAY_DEFAULT_URL ?? 'http://127.0.0.1:17389' }],
    routes: [],
  };
}

function backendFor(config: Config, chatId: string): Backend {
  const route = config.routes.find(r => r.chatId === chatId);
  const id = route?.backend ?? config.defaultBackend;
  const backend = config.backends.find(b => b.id === id);
  if (!backend) throw new Error(`backend not found: ${id}`);
  return backend;
}

function postJson(url: string, body: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(data.length) }, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

async function forwardMessage(config: Config, data: any): Promise<void> {
  const message = data?.message;
  if (!message) return;
  const eventId = data?.header?.event_id ?? message.message_id;
  const existing = ownership.get(eventId);
  if (existing?.status === 'delivered') return;
  ownership.set(eventId, { backend: existing?.backend ?? '', status: 'received', updatedAt: Date.now() });
  const chatId = message.chat_id;
  const stickyKey = message.root_id || message.thread_id || message.message_id;
  const sticky = stickyKey ? ownership.get(`thread:${stickyKey}`) : undefined;
  const backend = backendByOwner(config, sticky, 'thread') ?? backendFor(config, chatId);
  ownership.set(eventId, { backend: backend.id, status: 'inflight', updatedAt: Date.now() });
  try {
    await postJson(`${backend.url}/api/lark/events`, { larkAppId: config.larkAppId, rawEvent: data }, config.timeoutMs ?? 2500);
    ownership.set(eventId, { backend: backend.id, status: 'delivered', updatedAt: Date.now() });
    ownership.set(`message:${message.message_id}`, { backend: backend.id, status: 'delivered', updatedAt: Date.now() });
    if (stickyKey) ownership.set(`thread:${stickyKey}`, { backend: backend.id, status: 'delivered', updatedAt: Date.now() });
    const sessionId = data?.session_id ?? data?.sessionId ?? data?.message?.session_id;
    if (sessionId) ownership.set(`session:${sessionId}`, { backend: backend.id, status: 'delivered', updatedAt: Date.now() });
  } catch (err) {
    ownership.set(eventId, { backend: backend.id, status: 'failed', updatedAt: Date.now() });
    throw err;
  }
}

function valueFromAction(data: any): any {
  return data?.action?.value ?? data?.action_value ?? data?.value ?? {};
}

function ownerBackendForCard(config: Config, data: any): Backend {
  const value = valueFromAction(data);
  const backendId = value.backend_id ?? value.backendId;
  if (backendId) {
    const backend = config.backends.find(b => b.id === backendId);
    if (backend) return backend;
  }
  const rootId = value.root_id ?? value.rootId;
  if (rootId) {
    const owner = ownership.get(`thread:${rootId}`);
    { const backend = backendByOwner(config, owner, 'thread'); if (backend) return backend; }
  }
  const sessionId = value.session_id ?? value.sessionId;
  if (sessionId) {
    const owner = ownership.get(`session:${sessionId}`);
    { const backend = backendByOwner(config, owner, 'session'); if (backend) return backend; }
  }
  const messageId = data?.open_message_id ?? data?.message_id ?? data?.container?.open_message_id;
  if (messageId) {
    const owner = ownership.get(`message:${messageId}`);
    { const backend = backendByOwner(config, owner, 'message'); if (backend) return backend; }
  }
  logger.warn('[gateway] card action owner not found, falling back to default backend');
  return defaultBackend(config);
}

async function forwardCardAction(config: Config, data: any): Promise<any> {
  const backend = ownerBackendForCard(config, data);
  try {
    const result = await postJson(`${backend.url}/api/lark/card-actions`, { larkAppId: config.larkAppId, rawEvent: data }, config.timeoutMs ?? 2500);
    return result?.response;
  } catch (err: any) {
    logger.warn(`[gateway] card action forward failed: ${err?.message ?? err}`);
    return { toast: { type: 'warning', content: '操作超时，请稍后重试' } };
  }
}

export function startGateway(): void {
  const config = loadConfig();
  if (!config.larkAppId || !config.larkAppSecret) throw new Error('LARK_APP_ID/LARK_APP_SECRET are required');
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      await forwardMessage(config, data);
    },
    'card.action.trigger': async (data: any) => forwardCardAction(config, data),
  });
  const wsClient = new Lark.WSClient({ appId: config.larkAppId, appSecret: config.larkAppSecret, loggerLevel: Lark.LoggerLevel.warn });
  wsClient.start({ eventDispatcher: dispatcher });
  logger.info('[gateway] Lark gateway started');
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const current = resolve(fileURLToPath(import.meta.url));
if (invoked === current || invoked.endsWith('/src/lark-gateway.ts') || invoked.endsWith('/dist/lark-gateway.js')) startGateway();
