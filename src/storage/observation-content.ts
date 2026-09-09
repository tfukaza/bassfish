import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { ContentObservation, ObservedThread, ObservedTicket } from '../observation-types.js';

export interface ObservationFilter {
  threadOffset?: number;
  ticketOffset?: number;
  agentOffset?: number;
  turnOffset?: number;
  query?: string;
  threadState?: 'active' | 'archived' | 'deleted' | 'all';
  ticketState?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'all';
  owner?: string;
}
const ticketColumns =
  'id,title,description,owner,ownerName,state,revision,creator,creatorName,lastEditor,lastEditorName,createdAt,updatedAt';
function bytePage<T>(rows: T[]): T[] {
  let bytes = 0;
  return rows.filter((row, index) => {
    bytes += Buffer.byteLength(JSON.stringify(row));
    return index === 0 || bytes <= 350_000;
  });
}

export async function observedTickets(
  c: Connection,
  commit: string,
  where: string,
  params: unknown[],
  limit = 100,
): Promise<ObservedTicket[]> {
  const [rows] = await c.query<RowDataPacket[]>(
    `SELECT ${ticketColumns} FROM tickets AS OF ? WHERE ${where} ORDER BY updatedAt DESC,id LIMIT ?`,
    [commit, ...params, limit],
  );
  if (!rows.length) return [];
  const ids = rows.map(row => String(row.id));
  const [edges] = await c.query<RowDataPacket[]>(
    `SELECT d.ticketId,d.dependencyId,t.state AS dependencyState FROM ticket_dependencies AS OF ? d JOIN tickets AS OF ? t ON t.id=d.dependencyId WHERE d.ticketId IN (?) OR d.dependencyId IN (?)`,
    [commit, commit, ids, ids],
  );
  return rows.map(row => {
    const depends = edges.filter(edge => edge.ticketId === row.id);
    const blockedBy = depends
      .filter(edge => edge.dependencyState !== 'done')
      .map(edge => String(edge.dependencyId));
    return {
      ...row,
      revision: String(row.revision),
      dependsOn: depends.map(edge => String(edge.dependencyId)),
      blockedBy,
      blocks: edges.filter(edge => edge.dependencyId === row.id).map(edge => String(edge.ticketId)),
      ready: row.state === 'todo' && blockedBy.length === 0,
    } as ObservedTicket;
  });
}

export async function observedContent(
  c: Connection,
  commit: string,
  options: ObservationFilter,
): Promise<ContentObservation> {
  const threadOffset = options.threadOffset ?? 0;
  const ticketOffset = options.ticketOffset ?? 0;
  const query = `%${(options.query ?? '').replaceAll('=', '==').replaceAll('%', '=%').replaceAll('_', '=_')}%`;
  const tw = ["t.title LIKE ? ESCAPE '='"];
  const tp: unknown[] = [query];
  if (options.threadState && options.threadState !== 'all') {
    tw.push('t.state=?');
    tp.push(options.threadState);
  }
  const [counts] = await c.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM threads AS OF ? t WHERE ${tw.join(' AND ')}`,
    [commit, ...tp],
  );
  const [rows] = await c.query<RowDataPacket[]>(
    `SELECT t.*, COALESCE((SELECT MAX(o.createdAt) FROM operations AS OF ? o JOIN operation_objects AS OF ? x ON x.operationId=o.operationId WHERE x.resourceType='thread' AND x.resourceId=t.id),t.createdAt) AS updatedAt FROM threads AS OF ? t WHERE ${tw.join(' AND ')} ORDER BY updatedAt DESC,t.id LIMIT 100 OFFSET ?`,
    [commit, commit, commit, ...tp, threadOffset],
  );
  const ids = rows.map(row => String(row.id));
  let latest: RowDataPacket[] = [],
    authors: RowDataPacket[] = [];
  if (ids.length) {
    [latest] = await c.query<RowDataPacket[]>(
      `SELECT m.threadId,m.senderName,SUBSTRING(m.body,1,180) AS body,COALESCE((SELECT v.visible FROM message_visibility AS OF ? v WHERE v.messageId=m.id ORDER BY v.threadRevision DESC LIMIT 1),1) AS visible FROM messages AS OF ? m WHERE m.threadId IN (?) AND m.sequence=(SELECT MAX(n.sequence) FROM messages AS OF ? n WHERE n.threadId=m.threadId)`,
      [commit, commit, ids, commit],
    );
    [authors] = await c.query<RowDataPacket[]>(
      'SELECT DISTINCT threadId,senderName FROM messages AS OF ? WHERE threadId IN (?)',
      [commit, ids],
    );
  }
  const threads = bytePage(
    rows.map(row => {
      const preview = latest.find(message => message.threadId === row.id);
      return {
        ...row,
        revision: String(row.revision),
        headSequence: String(row.headSequence),
        preview: preview ? (preview.visible ? String(preview.body) : '[retracted]') : '',
        latestAuthor: preview?.senderName ?? null,
        participants: authors
          .filter(a => a.threadId === row.id)
          .map(a => String(a.senderName))
          .slice(0, 64),
      } as ObservedThread;
    }),
  );
  const kw = ["title LIKE ? ESCAPE '='"];
  const kp: unknown[] = [query];
  if (options.ticketState && options.ticketState !== 'all') {
    kw.push('state=?');
    kp.push(options.ticketState);
  }
  if (options.owner) {
    kw.push('ownerName=?');
    kp.push(options.owner);
  }
  const [ticketCounts] = await c.query<RowDataPacket[]>(
    `SELECT state,COUNT(*) AS count FROM tickets AS OF ? WHERE ${kw.join(' AND ')} GROUP BY state`,
    [commit, ...kp],
  );
  // OFFSET remains bound, and only metadata is selected, including for large ticket bodies.
  const [ticketIds] = await c.query<RowDataPacket[]>(
    `SELECT id FROM tickets AS OF ? WHERE ${kw.join(' AND ')} ORDER BY updatedAt DESC,id LIMIT 100 OFFSET ?`,
    [commit, ...kp, ticketOffset],
  );
  const tickets = bytePage(
    ticketIds.length
      ? await observedTickets(c, commit, 'id IN (?)', [ticketIds.map(t => String(t.id))])
      : [],
  );
  const totalThreads = Number(counts[0]?.count ?? 0);
  const totalTickets = ticketCounts.reduce((sum, row) => sum + Number(row.count), 0);
  return {
    commit,
    threads,
    tickets,
    totals: {
      threads: totalThreads,
      tickets: totalTickets,
      states: Object.fromEntries(ticketCounts.map(row => [String(row.state), Number(row.count)])),
    },
    nextThreadOffset:
      threadOffset + threads.length < totalThreads ? threadOffset + threads.length : null,
    nextTicketOffset:
      ticketOffset + tickets.length < totalTickets ? ticketOffset + tickets.length : null,
  };
}
