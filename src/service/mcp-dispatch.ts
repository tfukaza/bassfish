import { mapAsync, filterAsync } from '../async.js';
import { BassfishError, type MutationResult, type Ticket } from '../domain.js';
import type { Mutation } from '../domain.js';
import {
  presentNotifications,
  presentRead,
  presentThread,
  presentTicket,
  presentTurnStatus,
} from '../mcp-presenters.js';
import type { Bassfish } from '../service.js';
import { ticketStatuses } from '../ticket.js';
import {
  compare,
  decodeCursor,
  describeTicket,
  describeTickets,
  encodeCursor,
  sortThreads,
} from './resources.js';

const followKey = (projectId: string, threadId: string, identityId: string): string =>
  `${projectId}:${threadId}:${identityId}`;
const mutation = (value: unknown): Mutation => value as Mutation;
export async function dispatchMcp(
  service: Bassfish,
  handle: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  taskCapable = false,
): Promise<unknown> {
  switch (name) {
    case 'bindHostSession':
    case 'deliverHostNotifications':
      throw new BassfishError(
        'HOST_SESSION_UNAVAILABLE',
        'Host session binding is available only through a managed MCP adapter.',
      );
    case 'getContext': {
      const session = (await service.info(handle)) as {
        name: string;
        pendingRequests: Record<string, unknown>[];
        unreadNotificationCount: number;
      };
      const agents = (await service.listAgents(
        handle,
        !(args.includeOfflineAgents as boolean),
        false,
      )) as {
        agents: Record<string, unknown>[];
      };
      const pendingTurns = await mapAsync(session.pendingRequests, async pending => {
        const status = presentTurnStatus(pending);
        const request = await service.control.view(
          async state => await state.get('requests', String(status.requestToken)),
        );
        return status.state === 'claimed' && request?.turnId
          ? { ...status, turnToken: request.turnId }
          : status;
      });
      return {
        agentName: session.name,
        agents: agents.agents.map(agent => ({ name: agent.name, online: agent.online })),
        pendingTurns,
        unreadNotificationCount: session.unreadNotificationCount,
      };
    }
    case 'setAgentName': {
      const session = (await service.requestName(handle, args.name as string)) as {
        name: string;
      };
      return { agentName: session.name };
    }
    case 'notifications': {
      if (args.action === 'acknowledge') {
        const result = (await service.ackNotifications(
          handle,
          args.notificationIds as string[],
        )) as {
          acknowledged: number;
          unreadNotificationCount: number;
        };
        return { acknowledged: result.acknowledged, remaining: result.unreadNotificationCount };
      }
      return presentNotifications(
        await service.listNotifications(
          handle,
          args.limit as number,
          args.cursor as string | undefined,
        ),
      );
    }
    case 'waitForWork':
      throw new BassfishError(
        'TASKS_REQUIRED',
        'waitForWork is available only through a Tasks-capable MCP connection.',
      );
    case 'findResources': {
      const actor = await service.control.view(async state => {
        const value = await service.actor(state, handle);
        await service.ready(state, value.projectId);
        return value;
      });
      const cursor = decodeCursor(args.cursor);
      if (args.resourceType === 'thread') {
        let threads = sortThreads(await service.content.listThreads(actor.projectId)).filter(
          thread => thread.state === args.state,
        );
        if (args.threadId) {
          const thread = threads.find(value => value.id === args.threadId);
          if (!thread) throw new BassfishError('NOT_FOUND', 'Thread not found in this project.');
          return {
            resource: presentThread({
              ...thread,
              following: await service.control.view(async state =>
                Boolean(
                  await state.get(
                    'follows',
                    followKey(actor.projectId, thread.id, actor.identityId),
                  ),
                ),
              ),
            }),
          };
        }
        if (args.query) {
          const query = String(args.query).toLowerCase();
          threads = threads.filter(thread =>
            [thread.title, thread.description].some(value => value.toLowerCase().includes(query)),
          );
        }
        if (args.following !== undefined) {
          threads = await filterAsync(
            threads,
            async thread =>
              Boolean(
                await service.control.view(
                  async state =>
                    await state.get(
                      'follows',
                      followKey(actor.projectId, thread.id, actor.identityId),
                    ),
                ),
              ) === args.following,
          );
        }
        if (cursor) {
          threads = threads.filter(
            thread =>
              thread.createdAt > cursor[0] ||
              (thread.createdAt === cursor[0] && thread.id > cursor[1]),
          );
        }
        const limit = args.limit as number;
        const page = threads.slice(0, limit);
        const last = page.at(-1);
        return {
          resources: await mapAsync(page, async thread =>
            presentThread({
              ...thread,
              following: await service.control.view(async state =>
                Boolean(
                  await state.get(
                    'follows',
                    followKey(actor.projectId, thread.id, actor.identityId),
                  ),
                ),
              ),
            }),
          ),
          nextCursor:
            threads.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null,
        };
      }
      if (args.resourceType === 'ticket') {
        const allTickets = await service.content.listTickets(actor.projectId);
        let tickets = allTickets;
        if (args.ticketId) {
          const ticket = tickets.find(value => value.id === args.ticketId);
          if (!ticket) throw new BassfishError('NOT_FOUND', 'Ticket not found in this project.');
          return { resource: presentTicket(describeTicket(ticket, allTickets)) };
        }
        const states = args.states as Ticket['state'][];
        tickets = tickets.filter(ticket => states.includes(ticket.state));
        if (args.query) {
          const query = String(args.query).toLowerCase();
          tickets = tickets.filter(ticket =>
            [ticket.title, ticket.description].some(value => value.toLowerCase().includes(query)),
          );
        }
        if (args.owner) {
          const owner = await service.ticketOwner(actor.projectId, args.owner as string);
          tickets = tickets.filter(ticket => ticket.owner === owner.id);
        }
        if (args.ready !== undefined) {
          const statuses = ticketStatuses(allTickets);
          tickets = tickets.filter(ticket => statuses.get(ticket.id)!.ready === args.ready);
        }
        tickets.sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
        if (cursor) {
          tickets = tickets.filter(
            ticket =>
              ticket.createdAt > cursor[0] ||
              (ticket.createdAt === cursor[0] && ticket.id > cursor[1]),
          );
        }
        const limit = args.limit as number;
        const page = tickets.slice(0, limit);
        const last = page.at(-1);
        const metadata = new Map(describeTickets(allTickets).map(ticket => [ticket.id, ticket]));
        return {
          resources: page.map(ticket => presentTicket(metadata.get(ticket.id))),
          nextCursor:
            tickets.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null,
        };
      }
      throw new BassfishError(
        'RESOURCE_TYPE_MISMATCH',
        'Discovery requires a thread or ticket target.',
      );
    }
    case 'createResource': {
      if (args.resourceType === 'thread') {
        const result = (await service.createThread(
          handle,
          args.title as string,
          args.description as string,
        )) as MutationResult & {
          threadId: string;
        };
        return { threadId: result.threadId, revision: result.revision };
      }
      if (args.resourceType === 'ticket') {
        const result = (await service.createTicket(handle, {
          title: args.title as string,
          description: args.description as string,
          owner: args.owner as string,
          state: args.state as Ticket['state'],
          body: args.body as string,
          dependsOn: args.dependsOn as string[],
        })) as MutationResult & {
          ticketId: string;
        };
        return { ticketId: result.ticketId, revision: result.revision };
      }
      throw new BassfishError(
        'RESOURCE_TYPE_MISMATCH',
        'Creation requires a thread or ticket target.',
      );
    }
    case 'acquireTurn':
      return service.acquireMcpTurn(handle, args, signal, taskCapable);
    case 'cancelTurn':
      return presentTurnStatus(
        await service.cancelTurnRequest(handle, args.requestToken as string),
      );
    case 'readTurn': {
      const credential = await service.mcpTurnCredential(handle, args.turnToken as string);
      if (args.view === 'outline') {
        const result = (await service.ticketOutline(
          handle,
          credential.id,
          credential.fencingToken,
        )) as {
          headings: unknown[];
        };
        return { headings: result.headings };
      }
      if (args.view === 'find') {
        const result = (await service.findTicket(
          handle,
          credential.id,
          credential.fencingToken,
          args.query as string,
          args.mode as 'literal' | 'regex',
          args.limit as number,
        )) as {
          matches: unknown[];
        };
        return { matches: result.matches };
      }
      return presentRead(
        await service.readTurn(
          handle,
          credential.id,
          credential.fencingToken,
          args.cursor as string | undefined,
        ),
      );
    }
    case 'commitTurn': {
      const credential = await service.mcpTurnCredential(handle, args.turnToken as string);
      const result = await service.commitTurn(
        handle,
        credential.id,
        credential.fencingToken,
        credential.baseRevision,
        mutation(args.mutation),
      );
      return credential.resourceType === 'thread'
        ? {
            threadId: credential.resourceId,
            revision: result.revision,
            ...(result.messageId ? { messageId: result.messageId, sequence: result.sequence } : {}),
          }
        : { ticketId: credential.resourceId, revision: result.revision };
    }
    case 'releaseTurn': {
      const file = await service.control.view(async state =>
        (await state.all('requests')).find(
          request => request.turnId === args.turnToken && request.resourceType === 'files',
        ),
      );
      if (file) return await service.releaseFiles(handle, args.turnToken as string);
      const credential = await service.mcpTurnCredential(handle, args.turnToken as string);
      await service.releaseTurn(handle, credential.id, credential.fencingToken);
      return { released: true };
    }
  }
  throw new BassfishError('UNKNOWN_TOOL', 'Unknown Bassfish MCP operation.');
}
