import { spawnSync } from 'node:child_process';

const expected = [
  {
    name: 'Codex',
    targetVersion: '0.153.4',
    command: 'codex',
    version: ['--version'],
    mcp: ['mcp', '--help'],
    live: [
      'exec',
      'Use the configured Bassfish MCP server, call getContext, and print exactly BASSFISH_HOST_OK after it succeeds.',
    ],
  },
  {
    name: 'Claude Code',
    targetVersion: '2.1.265',
    command: 'claude',
    version: ['--version'],
    mcp: ['mcp', '--help'],
    live: [
      '-p',
      'Use the configured Bassfish MCP server, call getContext, and print exactly BASSFISH_HOST_OK after it succeeds.',
    ],
  },
  {
    name: 'OpenCode',
    targetVersion: '1.18.29',
    command: 'opencode',
    version: ['--version'],
    mcp: ['mcp', '--help'],
    live: [
      'run',
      'Use the configured Bassfish MCP server, call getContext, and print exactly BASSFISH_HOST_OK after it succeeds.',
    ],
  },
];
const live = process.argv.includes('--live');
const allowMissing = process.argv.includes('--allow-missing');
const results = [];
for (const host of expected) {
  const version = spawnSync(host.command, host.version, { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') {
    results.push({
      host: host.name,
      status: allowMissing ? 'missing' : 'failed',
      reason: 'executable not found',
    });
    continue;
  }
  if (version.status !== 0) {
    results.push({
      host: host.name,
      status: 'failed',
      reason: (version.stderr || version.stdout).trim(),
    });
    continue;
  }
  if (!version.stdout.includes(host.targetVersion)) {
    results.push({
      host: host.name,
      status: allowMissing ? 'version-mismatch' : 'failed',
      targetVersion: host.targetVersion,
      version: version.stdout.trim(),
      reason: 'release-candidate version is not installed',
    });
    continue;
  }
  const mcp = spawnSync(host.command, host.mcp, { encoding: 'utf8' });
  if (mcp.status !== 0 || !/mcp/i.test(mcp.stdout + mcp.stderr)) {
    results.push({
      host: host.name,
      status: 'failed',
      version: version.stdout.trim(),
      reason: 'MCP command unavailable',
    });
    continue;
  }
  if (!live) {
    results.push({
      host: host.name,
      status: 'launch-pass',
      targetVersion: host.targetVersion,
      version: version.stdout.trim(),
    });
    continue;
  }
  const run = spawnSync(host.command, host.live, {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: process.env.BASSFISH_HOST_SMOKE_WORKSPACE ?? process.cwd(),
  });
  results.push({
    host: host.name,
    status: run.status === 0 && /BASSFISH_HOST_OK/.test(run.stdout) ? 'live-pass' : 'failed',
    targetVersion: host.targetVersion,
    version: version.stdout.trim(),
    ...(run.status === 0 ? {} : { reason: (run.stderr || run.stdout).slice(-1000).trim() }),
  });
}
process.stdout.write(
  JSON.stringify({ live, platform: `${process.platform}-${process.arch}`, results }, null, 2) +
    '\n',
);
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
