import { runDaemon } from '../../src/daemon.js';
import { TursoStore } from '../../src/storage/turso.js';
import { TursoControl } from '../../src/storage/coordination.js';
import { connect } from '../../src/storage/native.js';

let failReplacement = false;
const originalOpen = TursoStore.open.bind(TursoStore);
TursoStore.open = (path, schema, count, options) =>
  originalOpen(
    path,
    schema
      ? schema +
          '; CREATE TABLE drain_test(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO drain_test VALUES(1,0);'
      : schema,
    count,
    {
      ...options,
      prepareLimit: Infinity,
      connect: async path => {
        if (failReplacement) throw new Error('injected replacement failure');
        return connect(path);
      },
    },
  );
let control!: TursoControl;
const originalControl = TursoControl.open.bind(TursoControl);
TursoControl.open = async path => {
  control = await originalControl(path);
  return control;
};
await runDaemon(process.argv[2]!);
let finish!: () => void;
const gate = new Promise<void>(resolve => {
  finish = resolve;
});
process.on('message', (message: { action: string }) => {
  if (message.action === 'hold') {
    void control.store
      .write(async tx => {
        await tx.run('INSERT INTO drain_test VALUES(2,0)');
        process.send!({ held: true });
        await gate;
        await tx.run('UPDATE drain_test SET n=9 WHERE id=2');
      })
      .then(() => process.send!({ drainedWriteCommitted: true }));
  } else if (message.action === 'fail') {
    Object.assign(control.store, { prepareLimit: 1 });
    failReplacement = true;
    void control.store
      .write(async tx => {
        await tx.run('UPDATE drain_test SET n=n+1 WHERE id=1');
        return 'committed';
      })
      .then(result => process.send!({ result }));
  } else if (message.action === 'finish') finish();
});
process.send!({ ready: true });
