import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { BassfishError } from './domain.js';
import { z } from 'zod';

const requestSchema = z
  .object({
    id: z.string().min(1).max(100),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();
interface Reply {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}
const maximumFrame = 2_000_000;
function frames(socket: Socket, receive: (frame: unknown) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', data => {
    buffer += data;
    if (Buffer.byteLength(buffer) > maximumFrame) {
      socket.destroy(new Error('IPC frame limit exceeded'));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        receive(JSON.parse(line));
      } catch {
        socket.destroy(new Error('Invalid IPC frame'));
        return;
      }
    }
  });
}
export type RpcHandler = (
  method: string,
  params: unknown,
  signal: AbortSignal,
  socket: Socket,
) => Promise<unknown>;
export async function listenRpc(
  path: string,
  handler: RpcHandler,
  disconnected: (socket: Socket) => void,
): Promise<{ server: Server; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const jobs = new Set<Promise<unknown>>();
  const server = createServer(socket => {
    sockets.add(socket);
    const running = new Map<string, AbortController>();
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const controller of running.values()) controller.abort();
      sockets.delete(socket);
      disconnected(socket);
    });
    frames(socket, frame => {
      const parsed = requestSchema.safeParse(frame);
      if (!parsed.success) {
        socket.destroy();
        return;
      }
      const request = parsed.data;
      if (request.method === '$cancel') {
        const p = request.params as { id?: string };
        if (typeof p?.id === 'string') running.get(p.id)?.abort();
        return;
      }
      if (running.has(request.id)) {
        socket.destroy();
        return;
      }
      const controller = new AbortController();
      running.set(request.id, controller);
      const job = handler(request.method, request.params, controller.signal, socket)
        .then(
          result => {
            if (!socket.destroyed)
              socket.write(JSON.stringify({ id: request.id, result } satisfies Reply) + '\n');
          },
          error => {
            const failure =
              error instanceof BassfishError
                ? error
                : new BassfishError(
                    'INTERNAL_ERROR',
                    'The backend operation failed; inspect daemon health.',
                  );
            if (!socket.destroyed)
              socket.write(
                JSON.stringify({
                  id: request.id,
                  error: { code: failure.code, message: failure.message },
                } satisfies Reply) + '\n',
              );
          },
        )
        .finally(() => {
          running.delete(request.id);
          jobs.delete(job);
        });
      jobs.add(job);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...jobs]);
    },
  };
}

export class RpcClient {
  private readonly requests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private constructor(readonly socket: Socket) {
    frames(socket, raw => {
      const reply = raw as Reply;
      const request = this.requests.get(reply.id);
      if (!request) return;
      this.requests.delete(reply.id);
      if (reply.error) request.reject(new BassfishError(reply.error.code, reply.error.message));
      else request.resolve(reply.result);
    });
    const failed = () => {
      for (const r of this.requests.values())
        r.reject(
          new BassfishError(
            'OUTCOME_UNKNOWN',
            'The connection closed. No request was retried; inspect its outcome before writing again.',
          ),
        );
      this.requests.clear();
    };
    socket.on('error', failed);
    socket.on('close', failed);
  }
  static async connect(path: string): Promise<RpcClient> {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RpcClient(socket);
  }
  async call<T = unknown>(
    method: string,
    params: unknown = {},
    signal?: AbortSignal,
    timeoutMs = 35_000,
  ): Promise<T> {
    if (signal?.aborted)
      throw new BassfishError('CANCELLED', 'Request was cancelled before submission.');
    if (this.socket.destroyed)
      throw new BassfishError(
        'CONNECTION_CLOSED',
        'Reconnect explicitly before submitting a new operation.',
      );
    const id = randomUUID();
    const abort = () => {
      if (!this.socket.destroyed)
        this.socket.write(
          JSON.stringify({ id: randomUUID(), method: '$cancel', params: { id } }) + '\n',
        );
    };
    const timer = setTimeout(() => {
      this.requests
        .get(id)
        ?.reject(
          new BassfishError(
            'OUTCOME_UNKNOWN',
            'The response deadline elapsed. No operation was retried; inspect current state.',
          ),
        );
      this.requests.delete(id);
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise<T>((resolve, reject) => {
        this.requests.set(id, { resolve: value => resolve(value as T), reject });
        this.socket.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  close(): void {
    this.socket.end();
  }
}
