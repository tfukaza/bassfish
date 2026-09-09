import { TursoControl } from '../../src/storage/coordination.js';
import { TursoContent } from '../../src/storage/content.js';
import { Bassfish } from '../../src/service.js';
import { SystemClock } from '../../src/runtime.js';
import type { WriteOperation } from '../../src/domain.js';

const [path, phase] = process.argv.slice(2);
const control = await TursoControl.open(path!);
let armed = false;
const pause = async () => {
  process.send!({ ready: true });
  setInterval(() => {}, 1000);
  await new Promise<void>(() => {});
};
class Content extends TursoContent {
  override async write(operation: WriteOperation) {
    const result = await super.write(operation);
    if (armed && phase === 'before') await pause();
    return result;
  }
}
const service = new Bassfish(control, new Content(control.store), new SystemClock());
await service.initialize();
const alice = await service.open('/crash/.git', 'Alice');
await service.open('/crash/.git', 'Bob');
const created = (await service.call(alice.agentHandle, 'createThread', {
  title: 'Crash',
  description: '',
})) as { threadId: string };
const offered = (await service.call(alice.agentHandle, 'requestTurn', {
  target: { type: 'thread', id: created.threadId },
})) as { offerId: string };
const turn = (await service.call(alice.agentHandle, 'claimTurn', { offerId: offered.offerId })) as {
  turn: { id: string; fencingToken: string };
  snapshot: { revision: string };
};
armed = true;
await service.call(alice.agentHandle, 'commitTurn', {
  turn: { id: turn.turn.id, fencingToken: turn.turn.fencingToken },
  baseRevision: turn.snapshot.revision,
  mutation: {
    kind: 'appendMessage',
    body: '@Bob durable',
    mentions: { agents: ['Bob'], here: false },
  },
});
await pause();
