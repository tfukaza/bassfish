import { z } from 'zod';
import {
  fileTargetsSchema,
  nameSchema,
  pageLimitSchema,
  threadStateSchema,
  ticketStateSchema,
  titleSchema,
} from './contracts.js';

const token = z.string().min(1).max(200);
const ticketBody = z
  .string()
  .refine(value => Buffer.byteLength(value, 'utf8') <= 256 * 1024, 'Ticket body exceeds 256 KiB.');

const publicMutation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('appendMessage'),
      body: z.string().min(1).max(16_000),
      mentions: z
        .object({
          agents: z.array(nameSchema).max(64).default([]),
          here: z.boolean().default(false),
          global: z.boolean().default(false),
        })
        .strict()
        .refine(value => !value.global || (value.agents.length === 0 && !value.here), {
          message: '@global cannot be combined with direct mentions or @here.',
        })
        .default({ agents: [], here: false, global: false }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('updateTicket'),
      title: titleSchema.optional(),
      description: z.string().max(2000).optional(),
      owner: nameSchema.optional(),
      state: ticketStateSchema.optional(),
      dependsOn: z.array(token).max(64).optional(),
    })
    .strict()
    .refine(
      value =>
        value.title !== undefined ||
        value.description !== undefined ||
        value.owner !== undefined ||
        value.state !== undefined ||
        value.dependsOn !== undefined,
      'Provide at least one ticket metadata field.',
    ),
  z.object({ kind: z.literal('replaceTicketBody'), body: ticketBody }).strict(),
  z
    .object({
      kind: z.literal('appendTicketBody'),
      body: z
        .string()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('patchTicketBody'),
      patch: z
        .string()
        .min(1)
        .max(512 * 1024),
    })
    .strict(),
]);

const turnTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread'), threadId: token }).strict(),
  z.object({ type: z.literal('files'), paths: fileTargetsSchema }).strict(),
  z.object({ type: z.literal('ticket'), ticketId: token }).strict(),
]);

export const mcpSchemas = {
  bindHostSession: z.object({ sessionId: token }).strict(),
  deliverHostNotifications: z
    .object({
      sessionId: token,
      phase: z.enum(['prompt', 'active', 'idle']),
    })
    .strict(),
  getContext: z.object({ includeOfflineAgents: z.boolean().default(false) }).strict(),
  setAgentName: z.object({ name: nameSchema }).strict(),
  notifications: z.discriminatedUnion('action', [
    z
      .object({
        action: z.literal('list'),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(500).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('acknowledge'),
        notificationIds: z.array(token).min(1).max(100),
      })
      .strict(),
  ]),
  waitForWork: z.object({}).strict(),
  findResources: z.discriminatedUnion('resourceType', [
    z
      .object({
        resourceType: z.literal('thread'),
        threadId: token.optional(),
        query: z.string().trim().min(1).max(200).optional(),
        state: threadStateSchema.default('active'),
        following: z.boolean().optional(),
        limit: pageLimitSchema,
        cursor: z.string().max(500).optional(),
      })
      .strict()
      .refine(
        value =>
          !(value.threadId && (value.query || value.following !== undefined || value.cursor)),
        'Exact thread lookup cannot be combined with search or pagination.',
      ),
    z
      .object({
        resourceType: z.literal('ticket'),
        ticketId: token.optional(),
        query: z.string().trim().min(1).max(200).optional(),
        owner: nameSchema.optional(),
        states: z
          .array(ticketStateSchema)
          .min(1)
          .max(4)
          .default(['todo', 'in_progress', 'blocked']),
        ready: z.boolean().optional(),
        limit: pageLimitSchema,
        cursor: z.string().max(500).optional(),
      })
      .strict()
      .refine(
        value =>
          !(
            value.ticketId &&
            (value.query || value.owner || value.ready !== undefined || value.cursor)
          ),
        'Exact ticket lookup cannot be combined with search or pagination.',
      ),
  ]),
  createResource: z.discriminatedUnion('resourceType', [
    z
      .object({
        resourceType: z.literal('thread'),
        title: titleSchema,
        description: z.string().max(2000).default(''),
      })
      .strict(),
    z
      .object({
        resourceType: z.literal('ticket'),
        title: titleSchema,
        description: z.string().max(2000),
        owner: nameSchema,
        state: ticketStateSchema.default('todo'),
        body: ticketBody.default(''),
        dependsOn: z.array(token).max(64).default([]),
      })
      .strict(),
  ]),
  acquireTurn: z.union([
    z
      .object({
        target: turnTarget,
        timeoutMs: z.number().int().min(0).max(20_000).default(20_000),
      })
      .strict(),
    z
      .object({
        requestToken: token,
        timeoutMs: z.number().int().min(0).max(20_000).default(20_000),
      })
      .strict(),
  ]),
  cancelTurn: z.object({ requestToken: token }).strict(),
  readTurn: z.discriminatedUnion('view', [
    z
      .object({ view: z.literal('page'), turnToken: token, cursor: z.string().max(500).optional() })
      .strict(),
    z.object({ view: z.literal('outline'), turnToken: token }).strict(),
    z
      .object({
        view: z.literal('find'),
        turnToken: token,
        query: z.string().min(1).max(1024),
        mode: z.enum(['literal', 'regex']).default('literal'),
        limit: pageLimitSchema,
      })
      .strict(),
  ]),
  commitTurn: z.object({ turnToken: token, mutation: publicMutation }).strict(),
  releaseTurn: z.object({ turnToken: token }).strict(),
} satisfies Record<string, z.ZodType>;

export type McpToolName = keyof typeof mcpSchemas;

// MCP output schemas must have an object root. Bassfish responses deliberately
// remain forward-compatible because threads, tickets, and host hooks add fields
// as the compact API evolves; the individual presenters remain the source of
// truth for those fields while this contract rejects non-object results.
const structuredOutput = z.record(z.string(), z.unknown());
export const mcpOutputSchemas = Object.fromEntries(
  (Object.keys(mcpSchemas) as McpToolName[]).map(name => [name, structuredOutput]),
) as Record<McpToolName, typeof structuredOutput>;

export const mcpDescriptions: Record<McpToolName, string> = {
  bindHostSession:
    'Internal host integration: bind this adapter to the current coding-agent session.',
  deliverHostNotifications:
    'Internal host integration: inject unread Bassfish notifications at a safe host boundary.',
  getContext:
    'Get the current agent name, teammate presence, unread count, and pending content and file turns.',
  setAgentName: 'Choose or reclaim an inactive agent name before requesting a turn.',
  notifications:
    'List unread project activity and work notifications, or acknowledge them after processing.',
  waitForWork:
    'Wait for unread direct mentions, @here, @global, ticket assignments, or newly-ready tickets. Requires MCP Tasks.',
  findResources: 'Find thread or ticket metadata without reading protected bodies.',
  createResource: 'Create a new chat thread or project ticket.',
  acquireTurn:
    'Acquire FIFO access to a thread, ticket, or an atomic set of files/directories. Resume with requestToken. Content turns have short leases; advisory file locks last until release or session loss. Reread files with native tools after acquiring.',
  cancelTurn: 'Cancel a queued request or unclaimed offer.',
  readTurn: 'Read another content page, or inspect headings or matches in a claimed ticket.',
  commitTurn: 'Commit one supported chat or ticket change and release the turn. Never retries.',
  releaseTurn:
    'Release a content turn or the complete file set. File writes use native filesystem tools.',
};
