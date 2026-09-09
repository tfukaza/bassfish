import { Writable, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { loadSonarUi } from '../../dist/sonar/ui-runtime.js';
const { render, createElement, SonarApp } = await loadSonarUi();
const sink = new Writable({
  write(chunk, encoding, done) {
    done();
  },
});
sink.isTTY = true;
sink.columns = 160;
sink.rows = 50;
const input = new PassThrough();
input.isTTY = true;
input.setRawMode = input.ref = input.unref = () => input;
const started = Date.now();
const snapshot = {
  protocolVersion: 2,
  epoch: 'test',
  cursor: '0',
  at: started,
  project: { id: 'p', commonDir: '/diagnostic/.git' },
  status: 'ready',
  agents: [
    {
      id: 'a',
      name: 'Agent',
      online: true,
      host: 'claude',
      workspace: '/diagnostic',
      lastSeen: started,
    },
  ],
  turns: [],
  content: {
    threads: Array.from({ length: 20 }, (_, i) => ({
      id: 't' + i,
      title: 'Thread ' + i,
      description: '',
      state: 'active',
      revision: '1',
      headSequence: '1',
      creator: 'a',
      createdAt: new Date(started).toISOString(),
      updatedAt: new Date(started).toISOString(),
      latestAuthor: 'Agent',
      preview: 'A fixed preview with Unicode 魚🐟',
      participants: ['Agent'],
    })),
    tickets: [],
    totals: { threads: 20, tickets: 0, states: {} },
    nextThreadOffset: null,
    nextTicketOffset: null,
  },
  activity: {
    events: [],
    nextBefore: null,
    recordingSince: started,
    retainedSince: null,
    buckets: Array(30).fill(0),
    bucketStart: started,
  },
};
let state = { phase: 'live', snapshot, gap: false };
const listeners = new Set();
const client = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getState: () => state,
  read: async () => {
    throw Error('unexpected detail');
  },
  close() {},
};
const app = render(createElement(SonarApp, { client, dimensions: { columns: 160, rows: 50 } }), {
  stdout: sink,
  stderr: sink,
  stdin: input,
  interactive: true,
  alternateScreen: true,
  incrementalRendering: true,
  maxFps: 60,
  exitOnCtrlC: false,
  patchConsole: false,
});
for (let i = 0; i < 1000; i++) {
  state = {
    ...state,
    snapshot: {
      ...snapshot,
      cursor: String(i),
      at: started + i * 1000,
      content: {
        ...snapshot.content,
        threads: snapshot.content.threads.map((t, j) => ({
          ...t,
          preview: 'Frame ' + i + ' thread ' + j + ' 魚🐟',
          headSequence: String(i + 1),
        })),
      },
    },
  };
  for (const f of listeners) f();
  await delay(10);
  if (i % 100 === 99) {
    global.gc();
    assert.ok(process.memoryUsage().heapUsed < 128 * 1048576);
    assert.equal(performance.getEntriesByType('measure').length, 0);
    process.stdout.write(
      JSON.stringify({
        mode: process.env.NODE_ENV || 'unset',
        frames: i + 1,
        heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
        measures: performance.getEntriesByType('measure').length,
      }) + '\n',
    );
  }
}
app.unmount();
await app.waitUntilExit();
input.destroy();
sink.destroy();
global.gc();
const before = process.memoryUsage().heapUsed;
performance.clearMeasures();
performance.clearMarks();
global.gc();
process.stdout.write(
  JSON.stringify({
    mode: process.env.NODE_ENV || 'unset',
    seconds: (Date.now() - started) / 1000,
    heapBeforeClearingMiB: Math.round(before / 1048576),
    heapAfterClearingMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
  }) + '\n',
);
