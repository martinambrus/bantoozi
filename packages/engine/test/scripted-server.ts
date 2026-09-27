import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A loopback HTTP server whose handler scripts transport-level behaviour the fake provider servers
 * do not offer: a body that stalls, a connection reset before or during the response, a chunked
 * body without `content-length`. The handler runs once the request body has been read.
 */
export interface ScriptedServer {
  url: string;
  /** Requests received so far. */
  hits(): number;
  close(): Promise<void>;
}

export async function startScriptedServer(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<ScriptedServer> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => handle(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A loopback port nothing listens on (bound once, then released). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
