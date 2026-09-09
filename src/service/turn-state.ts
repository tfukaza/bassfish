import {
  activeStates,
  reservedStates,
  type ControlState,
  type FileTurnRequest,
  type TurnRequest,
} from '../domain.js';
import { fileSetsOverlap } from '../files.js';

const values = Object.values;

type FinalTurnState = 'EXPIRED' | 'CANCELLED' | 'RELEASED' | 'FAILED' | 'COMMITTED';

export function pendingFor(state: ControlState, instanceId: string): TurnRequest[] {
  return values(state.requests).filter(
    request => request.instanceId === instanceId && activeStates.includes(request.state),
  );
}

export function finishRequest(
  request: TurnRequest,
  finalState: FinalTurnState,
  now: number,
  retentionMs: number,
  control?: ControlState,
): void {
  request.state = finalState;
  request.finishedAt = now;
  request.updatedAt = now;
  const task =
    control &&
    values(control.tasks).find(
      value => value.requestId === request.id && value.status === 'working',
    );
  if (!task) return;

  task.updatedAt = now;
  task.discardAt = now + retentionMs;
  if (finalState === 'FAILED') {
    task.status = 'failed';
    task.statusMessage = 'The turn request failed.';
    task.error = { code: -32603, message: 'The turn request failed.' };
  } else if (finalState !== 'COMMITTED') {
    task.status = 'cancelled';
    task.statusMessage =
      finalState === 'EXPIRED' ? 'The turn request expired.' : 'The turn request was cancelled.';
  }
}

function makeRequestAvailable(
  state: ControlState,
  request: TurnRequest,
  now: number,
  offerMs: number,
  newId: () => string,
): void {
  request.updatedAt = now;
  if (request.deliveryMode === 'task') {
    request.state = 'READY';
    const task = values(state.tasks).find(value => value.requestId === request.id);
    if (task) {
      task.updatedAt = now;
      task.statusMessage = 'Turn ready; poll the task to claim it.';
    }
    return;
  }
  request.state = 'OFFERED';
  request.offerId = newId();
  request.claimBy = now + offerMs;
}

export function materializeRequestOffer(
  state: ControlState,
  request: TurnRequest,
  now: number,
  offerMs: number,
  newId: () => string,
): void {
  if (request.state !== 'READY') return;
  request.state = 'OFFERED';
  request.offerId = newId();
  request.claimBy = now + offerMs;
  request.updatedAt = now;
  const task = values(state.tasks).find(
    value => value.requestId === request.id && value.status === 'working',
  );
  if (task) {
    task.statusMessage = 'Claiming the turn.';
    task.updatedAt = now;
  }
}

export function promoteFileRequests(
  state: ControlState,
  now: number,
  offerMs: number,
  newId: () => string,
): void {
  const requests = values(state.requests)
    .filter(
      (request): request is FileTurnRequest =>
        request.resourceType === 'files' && activeStates.includes(request.state),
    )
    .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
  const reserved = requests.filter(request => reservedStates.includes(request.state));
  const earlier: FileTurnRequest[] = [];
  for (const request of requests) {
    if (request.state !== 'QUEUED') continue;
    if (
      state.instances[request.instanceId]?.active &&
      !reserved.some(other => fileSetsOverlap(request.paths, other.paths)) &&
      !earlier.some(other => fileSetsOverlap(request.paths, other.paths))
    ) {
      makeRequestAvailable(state, request, now, offerMs, newId);
      reserved.push(request);
    }
    earlier.push(request);
  }
}

export function promoteRequests(
  state: ControlState,
  now: number,
  offerMs: number,
  newId: () => string,
): void {
  promoteFileRequests(state, now, offerMs, newId);
  for (const project of values(state.projects)) {
    if (project.recovering) continue;
    const all = values(state.requests).filter(
      request => request.resourceType !== 'files' && request.projectId === project.id,
    );
    const projects = all.filter(request => request.resourceType === 'project');
    if (projects.some(request => reservedStates.includes(request.state))) continue;
    const barrier = projects
      .filter(request => request.state === 'QUEUED')
      .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))[0];
    if (barrier) {
      for (const offered of all.filter(
        request => request.resourceType !== 'project' && request.state === 'OFFERED',
      )) {
        offered.state = 'QUEUED';
        delete offered.offerId;
        delete offered.claimBy;
      }
      if (
        all.some(
          request =>
            request.resourceType !== 'project' &&
            (request.state === 'CLAIMED' || request.state === 'COMMITTING'),
        )
      ) {
        continue;
      }
      if (state.instances[barrier.instanceId]?.active) {
        makeRequestAvailable(state, barrier, now, offerMs, newId);
      }
      continue;
    }
    for (const resource of values(state.resources).filter(
      resource =>
        resource.projectId === project.id && resource.type !== 'project' && resource.present,
    )) {
      const requests = all.filter(
        request => request.resourceType !== 'files' && request.resourceId === resource.id,
      );
      if (requests.some(request => reservedStates.includes(request.state))) continue;
      const next = requests
        .filter(request => request.state === 'QUEUED')
        .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))[0];
      if (!next || !state.instances[next.instanceId]?.active) continue;
      makeRequestAvailable(state, next, now, offerMs, newId);
    }
  }
}
