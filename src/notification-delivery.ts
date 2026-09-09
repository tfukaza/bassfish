export interface DeliveredNotification {
  notificationId: string;
  resourceType: 'thread' | 'ticket';
  resourceId: string;
  threadId?: string;
  ticketId?: string;
  sender: { identityId: string; name: string } | string;
  reasons: string[];
  content?:
    | {
        kind: 'thread_message';
        threadTitle: string;
        body: string;
        retracted: boolean;
      }
    | {
        kind: 'ticket_summary';
        title: string;
        state: string;
        owner: string;
      };
}

export interface DeliveryBatch {
  kind: 'actionable' | 'activity' | 'none';
  count: number;
  notificationIds: string[];
  threadIds: string[];
  ticketIds: string[];
  reasons: string[];
  senders: string[];
  notifications: DeliveredNotification[];
}

const senderName = (notification: DeliveredNotification): string =>
  typeof notification.sender === 'string' ? notification.sender : notification.sender.name;

export function formatDeliveryContext(batch: DeliveryBatch): string {
  const heading =
    batch.kind === 'actionable'
      ? '[Bassfish notification — action requested]'
      : '[Bassfish project activity]';
  const rows = batch.notifications.map(notification => {
    const reasons = notification.reasons.join(', ');
    if (notification.content?.kind === 'thread_message') {
      const body = notification.content.retracted
        ? '[message retracted or unavailable]'
        : notification.content.body;
      return `- ${notification.notificationId} · ${reasons} · ${senderName(notification)} in “${notification.content.threadTitle}” (${notification.threadId ?? notification.resourceId}):\n${body}`;
    }
    if (notification.content?.kind === 'ticket_summary')
      return `- ${notification.notificationId} · ${reasons} · ticket “${notification.content.title}” (${notification.ticketId ?? notification.resourceId}), state=${notification.content.state}, owner=${notification.content.owner}`;
    return `- ${notification.notificationId} · ${reasons} · ${notification.resourceType} ${notification.resourceId} from ${senderName(notification)}`;
  });
  return [
    heading,
    ...rows,
    `These notifications remain unread. After handling them, acknowledge these IDs with the Bassfish notifications tool: ${batch.notificationIds.join(', ')}`,
  ].join('\n');
}
