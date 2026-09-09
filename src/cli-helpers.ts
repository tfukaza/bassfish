import { BassfishError, requireThat } from './domain.js';

export type Call = <T = unknown>(name: string, args?: unknown) => Promise<T>;
export type CliInteraction = {
  interactive: boolean;
  confirm: (
    prompt: string,
    preview?: { request: { command: string; action?: string }; value: unknown },
  ) => Promise<boolean>;
};
export type Turn = {
  turn: { id: string; fencingToken: string };
  snapshot: { revision: string };
  page: { text?: string };
  nextCursor?: string | null;
};
export const credential = (turn: Turn) => ({
  id: turn.turn.id,
  fencingToken: turn.turn.fencingToken,
});

export function take(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  requireThat(
    value !== undefined && !value.startsWith('--'),
    'INVALID_ARGUMENT',
    `${name} requires a value.`,
  );
  args.splice(index, 2);
  return value;
}

export function booleanFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function comparablePreview(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([key]) => !['previewToken', 'expiresAt', 'nextCursor'].includes(key))
        .map(([key, child]) => [key, visit(child)]),
    );
  };
  return JSON.stringify(visit(value));
}

export async function acquire(call: Call, type: 'thread', id: string): Promise<Turn>;
export async function acquire(
  call: Call,
  type: 'project',
  purpose: 'snapshot' | 'export' | 'restore',
): Promise<Turn>;
export async function acquire(
  call: Call,
  type: 'thread' | 'project',
  value: string,
): Promise<Turn> {
  const target = type === 'thread' ? { type, id: value } : { type, purpose: value };
  const ticket = await call<{ state: string; requestId: string; offerId?: string }>('requestTurn', {
    target,
  });
  if (ticket.state !== 'offered') {
    await call('cancelTurnRequest', { requestId: ticket.requestId });
    throw new BassfishError(
      'TURN_BUSY',
      `${type === 'thread' ? 'Thread' : 'The project'} is busy. This request was cancelled, not retried.`,
    );
  }
  return call<Turn>('claimTurn', { offerId: ticket.offerId });
}
export async function release(call: Call, turn: Turn): Promise<void> {
  await call('releaseTurn', { turn: credential(turn) });
}

export function boundedIntegerOption(
  args: string[],
  name: string,
  bounds: { min: number; max?: number },
): number | undefined {
  const raw = take(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  requireThat(
    Number.isInteger(value) &&
      value >= bounds.min &&
      (bounds.max === undefined || value <= bounds.max),
    'INVALID_ARGUMENT',
    `${name} must be an integer from ${bounds.min}${bounds.max === undefined ? ' upward' : ` through ${bounds.max}`}.`,
  );
  return value;
}

export async function mutation(
  call: Call,
  type: 'thread',
  id: string,
  value: Record<string, unknown>,
): Promise<unknown> {
  const turn = await acquire(call, type, id);
  let consumed = false;
  try {
    const result = await call('commitTurn', {
      turn: credential(turn),
      baseRevision: turn.snapshot.revision,
      mutation: value,
    });
    consumed = true;
    return result;
  } finally {
    if (!consumed) await release(call, turn).catch(() => {});
  }
}
