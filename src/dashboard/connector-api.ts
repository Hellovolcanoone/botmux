import type { IncomingMessage, ServerResponse } from 'node:http';
import { getConnector, listConnectors } from '../services/connector-store.js';
import { listTriggerLogs } from '../services/trigger-log-store.js';
import { jsonRes } from './workflow-api.js';

export async function handleConnectorApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/connectors') {
    jsonRes(res, 200, { connectors: listConnectors() });
    return true;
  }

  let m: RegExpMatchArray | null;
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/connectors\/([^/]+)$/))) {
    const connector = getConnector(decodeURIComponent(m[1]));
    if (!connector) {
      jsonRes(res, 404, { ok: false, error: 'unknown_connector' });
      return true;
    }
    jsonRes(res, 200, { connector });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/trigger-logs') {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const connectorId = url.searchParams.get('connectorId') ?? undefined;
    jsonRes(res, 200, { logs: listTriggerLogs({ limit, connectorId }) });
    return true;
  }

  return false;
}
