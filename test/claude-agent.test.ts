import { mapAsync } from '../src/async.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  ancestryFromProcessTable,
  readOrCreateClaudeClientId,
  readOrCreateOpenCodeClientId,
  selectNativeCandidate,
} from '../src/agents/claude-native.js';
import { TursoControl } from '../src/storage/coordination.js';
import { Bassfish } from '../src/service.js';
import { fixture } from './support.js';
import { formatClaudeDeliveryNotification } from '../src/notifications-cli.js';
const exec = promisify(execFile);
test('Claude plugin client ID is stable, private, and UUID-shaped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bassfish-claude-'));
  const first = await readOrCreateClaudeClientId(dir);
  const second = await readOrCreateClaudeClientId(dir);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal((await stat(join(dir, 'bassfish-client-id'))).mode & 0o777, 0o600);
});
test('OpenCode plugin client ID is stable in the Bassfish data directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bassfish-opencode-'));
  const first = await readOrCreateOpenCodeClientId(dir);
  const second = await readOrCreateOpenCodeClientId(dir);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal((await stat(join(dir, 'native', 'opencode', 'client-id'))).mode & 0o777, 0o600);
});
test('process ancestry parsing is bounded and native matching fails closed on ambiguity', () => {
  assert.deepEqual(ancestryFromProcessTable('10 9\n9 2\n2 1\n1 0\n', 10), [10, 9, 2, 1]);
  const monitor = [20, 10, 5, 1];
  assert.equal(
    selectNativeCandidate(
      [
        { handle: 'near', processAncestors: [30, 10, 5, 1] },
        { handle: 'far', processAncestors: [40, 41, 5, 1] },
      ],
      monitor,
    )?.handle,
    'near',
  );
  assert.equal(
    selectNativeCandidate(
      [
        { handle: 'a', processAncestors: [30, 10, 1] },
        { handle: 'b', processAncestors: [31, 10, 1] },
      ],
      monitor,
    ),
    undefined,
  );
  assert.equal(
    selectNativeCandidate([{ handle: 'root-only', processAncestors: [99, 1] }], monitor),
    undefined,
  );
});
test('native host session IDs durably bind identity without becoming installation defaults', async t => {
  const f = await fixture();
  t.after(f.close);
  const native = (host: 'claude' | 'codex' = 'claude') => ({ host });
  const first = await f.service.open(
    '/repo/.git',
    undefined,
    native(),
    '/repo/.git',
    'session-one',
  );
  const original = first.session as {
    identityId: string;
    adapterInstanceId: string;
    name: string;
  };
  const concurrent = await f.service.open(
    '/repo/.git',
    undefined,
    native(),
    '/repo/.git',
    'session-one',
  );
  const attached = concurrent.session as typeof original;
  assert.equal(attached.identityId, original.identityId);
  assert.equal(attached.name, original.name);
  assert.notEqual(attached.adapterInstanceId, original.adapterInstanceId);
  await f.service.requestName(first.agentHandle, 'Reviewer');
  assert.equal(
    (
      (await f.service.info(concurrent.agentHandle)) as {
        name: string;
      }
    ).name,
    'Reviewer',
  );
  await f.service.disconnect(first.agentHandle);
  await f.service.disconnect(concurrent.agentHandle);
  const resumed = await f.service.open(
    '/repo/.git',
    undefined,
    native(),
    '/repo/.git',
    'session-one',
  );
  assert.equal(
    (
      resumed.session as {
        identityId: string;
      }
    ).identityId,
    original.identityId,
  );
  assert.equal(
    (
      resumed.session as {
        name: string;
      }
    ).name,
    'Reviewer',
  );
  const otherClaude = await f.service.open(
    '/repo/.git',
    undefined,
    native(),
    '/repo/.git',
    'session-two',
  );
  assert.notEqual(
    (
      otherClaude.session as {
        identityId: string;
      }
    ).identityId,
    original.identityId,
  );
  assert.notEqual(
    (
      otherClaude.session as {
        name: string;
      }
    ).name,
    'Reviewer',
  );
  const sameOpaqueIdOnCodex = await f.service.open(
    '/repo/.git',
    undefined,
    native('codex'),
    '/repo/.git',
    'session-one',
  );
  assert.notEqual(
    (
      sameOpaqueIdOnCodex.session as {
        identityId: string;
      }
    ).identityId,
    original.identityId,
  );
  const sameSessionInAnotherProject = await f.service.open(
    '/other/.git',
    undefined,
    native(),
    '/other',
    'session-one',
  );
  assert.notEqual(
    (
      sameSessionInAnotherProject.session as {
        identityId: string;
      }
    ).identityId,
    original.identityId,
  );
  await assert.rejects(
    f.service.open('/repo/.git', 'Reviewer', native(), '/repo/.git', 'session-three'),
    (error: unknown) =>
      (
        error as {
          code?: string;
        }
      ).code === 'NAME_BOUND_TO_SESSION',
  );
  const restarted = new Bassfish(f.control, f.content, f.clock);
  await restarted.initialize();
  const afterDaemonRestart = await restarted.open(
    '/repo/.git',
    undefined,
    native(),
    '/repo/.git',
    'session-one',
  );
  assert.equal(
    (
      afterDaemonRestart.session as {
        identityId: string;
      }
    ).identityId,
    original.identityId,
  );
  assert.equal(
    (
      afterDaemonRestart.session as {
        name: string;
      }
    ).name,
    'Reviewer',
  );
});
test('control schema v5 requires an explicit reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bassfish-schema-'));
  const path = join(dir, 'control.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, commonDir TEXT NOT NULL UNIQUE, recovering INTEGER NOT NULL CHECK(recovering IN (0,1)));
    CREATE TABLE identities (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, FOREIGN KEY(projectId) REFERENCES projects(id), UNIQUE(projectId,name COLLATE NOCASE));
    INSERT INTO projects VALUES('project','/repo/.git',0);
    INSERT INTO identities VALUES('identity','project','Reviewer');
    PRAGMA user_version=5;
  `);
  old.close();
  await assert.rejects(
    async () => await TursoControl.open(path),
    (error: unknown) =>
      (
        error as {
          code?: string;
        }
      ).code === 'SCHEMA_MISMATCH',
  );
});
test('control schema v6 requires an explicit reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bassfish-schema-v6-'));
  const path = join(dir, 'control.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, commonDir TEXT NOT NULL UNIQUE, recovering INTEGER NOT NULL CHECK(recovering IN (0,1)));
    CREATE TABLE identities (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, FOREIGN KEY(projectId) REFERENCES projects(id), UNIQUE(projectId,name COLLATE NOCASE));
    CREATE TABLE nativeHostPreferences (projectId TEXT NOT NULL, identityId TEXT NOT NULL, host TEXT NOT NULL CHECK(host='claude'), clientId TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(projectId,host,clientId));
    CREATE TABLE hostBindings (projectId TEXT NOT NULL, identityId TEXT NOT NULL, host TEXT NOT NULL, sessionId TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(projectId,identityId,host));
    INSERT INTO projects VALUES('project','/repo/.git',0);
    INSERT INTO identities VALUES('identity','project','Reviewer');
    INSERT INTO nativeHostPreferences VALUES('project','identity','claude','client',1);
    INSERT INTO hostBindings VALUES('project','identity','opencode','obsolete-session',1);
    PRAGMA user_version=6;
  `);
  old.close();
  await assert.rejects(
    async () => await TursoControl.open(path),
    (error: unknown) =>
      (
        error as {
          code?: string;
        }
      ).code === 'SCHEMA_MISMATCH',
  );
});
test('Claude marketplace plugin binds sessions and checks notifications at safe boundaries', async () => {
  const root = join(process.cwd(), 'plugins', 'claude');
  const manifest = JSON.parse(
    await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as Record<string, any>;
  const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')) as Record<string, any>;
  const monitors = JSON.parse(
    await readFile(join(root, 'monitors', 'monitors.json'), 'utf8'),
  ) as Record<string, any>[];
  const hooks = JSON.parse(await readFile(join(root, 'hooks', 'hooks.json'), 'utf8')) as Record<
    string,
    any
  >;
  const coordinationSkill = await readFile(
    join(root, 'skills', 'coordinate-peers', 'SKILL.md'),
    'utf8',
  );
  const marketplace = JSON.parse(
    await readFile(join(process.cwd(), '.claude-plugin', 'marketplace.json'), 'utf8'),
  ) as Record<string, any>;
  assert.equal(manifest.userConfig, undefined);
  assert.equal(mcp.mcpServers.bassfish.command, '${CLAUDE_PLUGIN_ROOT}/bin/bassfish-launcher');
  assert.equal(mcp.mcpServers.bassfish.env.BASSFISH_CLAUDE_NATIVE, '1');
  assert.match(monitors[0]!.command, /^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/bassfish-launcher"/);
  assert.match(monitors[0]!.command, /--native-claude/);
  assert.equal(monitors[0]!.when, 'always');
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].server, 'plugin:bassfish:bassfish');
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].tool, 'deliverHostNotifications');
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].input.sessionId, '${session_id}');
  assert.equal(hooks.hooks.PostToolBatch[0].hooks[0].input.phase, 'active');
  assert.equal(hooks.hooks.Stop[0].hooks[0].input.phase, 'idle');
  assert.match(coordinationSkill, /^---\nname: coordinate-peers\n/);
  assert.match(coordinationSkill, /same\s+Git repository/);
  assert.match(coordinationSkill, /No reply, ordering, acknowledgement/);
  assert.match(coordinationSkill, /TURN_BUSY.*never permission/s);
  assert.match(coordinationSkill, /held, refused, dropped, unavailable, or ambiguous/);
  assert.equal(marketplace.plugins[0].source, './plugins/claude');
});
test('Claude launcher resolves Bassfish through the login shell and preserves arguments', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bassfish-claude-launcher-'));
  t.after(async () => await rm(dir, { recursive: true, force: true }));
  const launcher = join(process.cwd(), 'plugins', 'claude', 'bin', 'bassfish-launcher');
  const fakeBin = join(dir, 'managed-bin');
  const fakeBassfish = join(fakeBin, 'bassfish');
  const fakeNode = join(fakeBin, 'node');
  const fakeShell = join(dir, 'login-shell');
  await mkdir(fakeBin);
  await writeFile(fakeBassfish, '#!/usr/bin/env node\n', 'utf8');
  await writeFile(
    fakeNode,
    '#!/bin/sh\nprintf \'node=%s\\n\' "$0"\nprintf \'args=%s\\n\' "$*"\nprintf \'path=%s\\n\' "$PATH"\n',
    'utf8',
  );
  await writeFile(fakeShell, `#!/bin/sh\nprintf '%s\\n' '${fakeBassfish}'\n`, 'utf8');
  await Promise.all(
    await mapAsync([fakeBassfish, fakeNode, fakeShell], async path => await chmod(path, 0o755)),
  );
  const result = await exec(launcher, ['mcp', '--workspace', '/repo with spaces'], {
    env: { PATH: '/usr/bin:/bin', SHELL: fakeShell },
  });
  assert.match(
    result.stdout,
    new RegExp(`node=${fakeNode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(result.stdout, /args=.*bassfish mcp --workspace \/repo with spaces/);
  assert.match(
    result.stdout,
    new RegExp(`path=${fakeBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`),
  );
});
test('Claude launcher reports an actionable error when Bassfish is unavailable', async () => {
  const launcher = join(process.cwd(), 'plugins', 'claude', 'bin', 'bassfish-launcher');
  await assert.rejects(
    exec(launcher, ['--version'], { env: { PATH: '/usr/bin:/bin', SHELL: '/bin/false' } }),
    (error: unknown) => {
      const failure = error as {
        code?: number;
        stderr?: string;
      };
      assert.equal(failure.code, 127);
      assert.match(failure.stderr ?? '', /npm install -g @bassfish\/cli@latest/);
      return true;
    },
  );
});
test('Codex marketplace plugin enables native MCP and delivers at safe boundaries', async () => {
  const root = join(process.cwd(), 'plugins', 'bassfish');
  const manifest = JSON.parse(
    await readFile(join(root, '.codex-plugin', 'plugin.json'), 'utf8'),
  ) as Record<string, any>;
  const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')) as Record<string, any>;
  const portableManifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')) as Record<
    string,
    any
  >;
  const portableMcp = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as Record<
    string,
    any
  >;
  const hooks = JSON.parse(await readFile(join(root, 'hooks', 'hooks.json'), 'utf8')) as Record<
    string,
    any
  >;
  const marketplace = JSON.parse(
    await readFile(join(process.cwd(), '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  ) as Record<string, any>;
  assert.match(manifest.version, /^0\.5\.0\+codex\.\d{14}$/);
  assert.equal(mcp.mcpServers.bassfish.env.BASSFISH_CODEX_NATIVE, '1');
  assert.equal(
    portableManifest.$schema,
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  );
  assert.equal(portableManifest.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.equal(portableMcp.mcpServers.bassfish.type, 'stdio');
  assert.equal(portableMcp.mcpServers.bassfish.env.BASSFISH_CODEX_NATIVE, '1');
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].tool, 'deliverHostNotifications');
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].input.sessionId, '${session_id}');
  assert.equal(hooks.hooks.PostToolUse[0].hooks[0].input.phase, 'active');
  assert.equal(hooks.hooks.Stop[0].hooks[0].input.phase, 'idle');
  assert.equal(marketplace.name, 'bassfish');
  assert.equal(marketplace.plugins[0].source.path, './plugins/bassfish');
});
test('Claude monitor emits content-bearing native notifications', () => {
  const notification = formatClaudeDeliveryNotification({
    kind: 'actionable',
    count: 1,
    notificationIds: ['direct-1'],
    threadIds: ['thread-1'],
    ticketIds: [],
    reasons: ['direct_mention'],
    senders: ['Alice'],
    notifications: [
      {
        notificationId: 'direct-1',
        resourceType: 'thread',
        resourceId: 'thread-1',
        threadId: 'thread-1',
        sender: { identityId: 'alice', name: 'Alice' },
        reasons: ['direct_mention'],
        content: {
          kind: 'thread_message',
          threadTitle: 'Coordination',
          body: '@Reviewer please check the latest decision.',
          retracted: false,
        },
      },
    ],
  });
  assert.equal(notification.type, 'bassfish_notifications');
  assert.match(String(notification.message), /latest decision/);
  assert.match(String(notification.message), /direct-1/);
});
