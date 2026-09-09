import {
  BassfishError,
  type ContentTurnRequest,
  type Mutation,
  type ResourceType,
} from '../domain.js';
import type { Bassfish } from '../service.js';

type Options = { taskCapable?: boolean };
type Credential = { id: string; fencingToken: string };

const values = Object.values;

const mutation = (value: unknown): Mutation => value as Mutation;

export async function dispatchAdmin(
  service: Bassfish,
  handle: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  options: Options = {},
): Promise<unknown> {
  switch (name) {
    case 'getSession':
      return service.info(handle);
    case 'setAgentName':
      return service.requestName(handle, args.name as string);
    case 'listAgents':
      return service.listAgents(handle, args.onlineOnly as boolean, args.includeSelf as boolean);
    case 'followThread':
      return service.followThread(handle, args.threadId as string);
    case 'unfollowThread':
      return service.unfollowThread(handle, args.threadId as string);
    case 'listNotifications':
      return service.listNotifications(
        handle,
        args.limit as number,
        args.cursor as string | undefined,
      );
    case 'waitForWork':
      throw new BassfishError(
        'TASKS_REQUIRED',
        'waitForWork is available through a Tasks-capable MCP connection.',
      );
    case 'ackNotifications':
      return service.ackNotifications(handle, args.notificationIds as string[]);
    case 'createThread':
      return service.createThread(handle, args.title as string, args.description as string);
    case 'listThreads':
      return service.listThreadMetadata(handle, args);
    case 'getThread':
      return service.getThreadMetadata(handle, args.threadId as string);
    case 'searchThreads':
      return service.searchThreadMetadata(handle, args);
    case 'requestTurn': {
      const target = args.target as {
        type: ResourceType;
        id?: string;
        purpose?: ContentTurnRequest['purpose'];
      };
      const mode = options.taskCapable ? 'task' : 'ticket';
      const result =
        target.type === 'project'
          ? await service.requestProjectTurn(handle, target.purpose, mode)
          : await service.requestResourceTurn(handle, target.type, target.id!, mode);
      const task = service.control.view(state =>
        values(state.tasks).find(value => value.requestId === result.requestId),
      );
      return task?.status === 'working' ? { task: service.taskView(task) } : result;
    }
    case 'getTurnRequest':
      return service.status(handle, args.requestId as string);
    case 'waitForTurn':
      return service.waitForTurn(
        handle,
        args.requestId as string,
        args.timeoutMs as number,
        signal,
      );
    case 'cancelTurnRequest':
      return service.cancelTurnRequest(handle, args.requestId as string);
    case 'claimTurn':
      return service.claimTurn(handle, args.offerId as string, 20);
    case 'readTurn': {
      const credential = args.turn as Credential;
      return service.readTurn(
        handle,
        credential.id,
        credential.fencingToken,
        args.cursor as string | undefined,
      );
    }
    case 'releaseTurn': {
      const credential = args.turn as Credential;
      return service.releaseTurn(handle, credential.id, credential.fencingToken);
    }
    case 'commitTurn': {
      const credential = args.turn as Credential;
      return service.commitTurn(
        handle,
        credential.id,
        credential.fencingToken,
        args.baseRevision as string,
        mutation(args.mutation),
      );
    }
    case 'inspectSnapshot': {
      const credential = args.turn as Credential;
      return service.projectSnapshotInfo(handle, credential.id, credential.fencingToken);
    }
    case 'exportSnapshot': {
      const credential = args.turn as Credential;
      return service.exportProject(handle, credential.id, credential.fencingToken);
    }
    case 'listSnapshotHistory': {
      const credential = args.turn as Credential;
      return service.projectHistoryList(
        handle,
        credential.id,
        credential.fencingToken,
        args.limit as number,
        args.cursor as string | undefined,
      );
    }
    case 'previewSnapshotRestore': {
      const credential = args.turn as Credential;
      return service.previewProjectRestore(
        handle,
        credential.id,
        credential.fencingToken,
        args.targetCommit as string,
        args.limit as number,
        args.cursor as string | undefined,
      );
    }
    case 'restoreSnapshot': {
      const credential = args.turn as Credential;
      return service.restoreProject(
        handle,
        credential.id,
        credential.fencingToken,
        args.previewToken as string,
      );
    }
    case 'listHistory': {
      const credential = args.turn as Credential;
      return service.resourceHistory(
        handle,
        credential.id,
        credential.fencingToken,
        args.offset as number,
        args.limit as number,
      );
    }
    case 'readRevision': {
      const credential = args.turn as Credential;
      return service.resourceAt(
        handle,
        credential.id,
        credential.fencingToken,
        args.revision as string,
        20,
        args.cursor as string | undefined,
      );
    }
    case 'diffRevision': {
      const credential = args.turn as Credential;
      return service.diffResource(
        handle,
        credential.id,
        credential.fencingToken,
        args.revision as string,
      );
    }
    case 'previewRestore': {
      const credential = args.turn as Credential;
      return service.previewRestore(
        handle,
        credential.id,
        credential.fencingToken,
        args.revision as string,
      );
    }
    case 'restoreRevision': {
      const credential = args.turn as Credential;
      return service.restoreRevision(
        handle,
        credential.id,
        credential.fencingToken,
        args.previewToken as string,
      );
    }
  }
  throw new BassfishError('UNKNOWN_TOOL', 'Unknown Bassfish operation.');
}
