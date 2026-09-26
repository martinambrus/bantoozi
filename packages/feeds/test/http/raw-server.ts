import { createServer, type AddressInfo, type Socket } from 'node:net';

/**
 * A raw TCP server on a random loopback port for responses no HTTP library would produce:
 * resets, silent closes, stalled bodies, malformed or oversized headers.
 */
export interface RawServer {
  port: number;
  url(path?: string): string;
  /** Connections accepted so far. */
  connections: number;
  close(): Promise<void>;
}

export async function startRawServer(onRequest: (socket: Socket) => void): Promise<RawServer> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let received = '';
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1');
      if (received.includes('\r\n\r\n')) {
        socket.off('data', onData);
        onRequest(socket);
      }
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (path = '/') => `http://127.0.0.1:${port}${path}`,
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
