import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BassfishError } from './domain.js';

export const DOLT_VERSION = '2.3.2';

const checksums: Record<string, string> = {
  'dolt-darwin-amd64.tar.gz': '6e438bcb2ffa1e4d0fcf06c0add56c0e87d7c9d2fc95de55a3eed2d5346e9f2b',
  'dolt-darwin-arm64.tar.gz': 'b576072541393579980161e86ac8ff83a447eb3eb47a17d92968bf72be098cad',
  'dolt-linux-amd64.tar.gz': '7a2949fa2b2b3799ee1e57e6d64519a8d65d675fd832f6469d4e07e5a1c72b14',
  'dolt-linux-arm64.tar.gz': 'b2231e84e06adf95ea81c6e889409ee7a72de5a96cb03bbf1bf3433ac763cf9c',
};

export function normalizedArchitecture(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch;
}

export function managedDoltBinary(dataDir: string, platform = process.platform, arch = process.arch): string {
  return join(dataDir, 'tools', 'dolt', DOLT_VERSION, `${platform}-${normalizedArchitecture(arch)}`, 'bin', 'dolt');
}

export async function readDoltVersion(binary: string): Promise<string | undefined> {
  try {
    const result = await promisify(execFile)(binary, ['version'], { timeout: 5_000 });
    const match = result.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/);
    return match?.[1];
  } catch { return undefined; }
}

export function verifyDoltArchive(name: string, bytes: Uint8Array): void {
  const expected = checksums[name];
  if (!expected) throw new BassfishError('UNSUPPORTED_PLATFORM', `No verified Dolt ${DOLT_VERSION} archive exists for this platform.`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new BassfishError('DOLT_CHECKSUM', 'Dolt checksum mismatch. Nothing was installed.');
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface SetupDoltOptions {
  platform?: string;
  arch?: string;
  /** null explicitly ignores the process environment, which is useful for isolated verification. */
  overrideBinary?: string | null;
  fetcher?: Fetcher;
}
export interface SetupDoltResult {
  version: string;
  path: string;
  source: 'managed' | 'override';
  installed: boolean;
}

export async function setupDolt(dataDir: string, options: SetupDoltOptions = {}): Promise<SetupDoltResult> {
  const override = options.overrideBinary === undefined ? process.env.BASSFISH_DOLT_BIN : options.overrideBinary ?? undefined;
  if (override) {
    const path = resolve(override); const version = await readDoltVersion(path);
    if (version !== DOLT_VERSION) throw new BassfishError('DOLT_VERSION', `BASSFISH_DOLT_BIN must point to Dolt ${DOLT_VERSION}.`);
    return { version, path, source: 'override', installed: false };
  }

  const platform = options.platform ?? process.platform;
  const arch = normalizedArchitecture(options.arch ?? process.arch);
  if (!['darwin', 'linux'].includes(platform) || !['amd64', 'arm64'].includes(arch)) {
    throw new BassfishError('UNSUPPORTED_PLATFORM', `Bassfish setup supports macOS and Linux on arm64 or x64. Set BASSFISH_DOLT_BIN to Dolt ${DOLT_VERSION} on other platforms.`);
  }
  const archiveBase = `dolt-${platform}-${arch}`;
  const archiveName = `${archiveBase}.tar.gz`;
  const target = join(dataDir, 'tools', 'dolt', DOLT_VERSION, `${platform}-${arch}`);
  const binary = join(target, 'bin', 'dolt');
  if (await readDoltVersion(binary) === DOLT_VERSION) return { version: DOLT_VERSION, path: binary, source: 'managed', installed: false };

  const parent = join(dataDir, 'tools', 'dolt', DOLT_VERSION);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(parent, '.install-'));
  let backup: string | undefined;
  try {
    const response = await (options.fetcher ?? fetch)(`https://github.com/dolthub/dolt/releases/download/v${DOLT_VERSION}/${archiveName}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new BassfishError('DOLT_DOWNLOAD', `Dolt download returned HTTP ${response.status}. Nothing was installed.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifyDoltArchive(archiveName, bytes);
    const archivePath = join(temporary, archiveName);
    await writeFile(archivePath, bytes, { mode: 0o600 });
    await promisify(execFile)('tar', ['-xzf', archivePath, '-C', temporary]);
    const extracted = join(temporary, archiveBase);
    const extractedBinary = join(extracted, 'bin', 'dolt');
    await chmod(extractedBinary, 0o755);
    if (await readDoltVersion(extractedBinary) !== DOLT_VERSION) throw new BassfishError('DOLT_VERSION', `Downloaded archive did not contain Dolt ${DOLT_VERSION}. Nothing was installed.`);

    // Another setup process may have completed while this archive was downloading.
    if (await readDoltVersion(binary) === DOLT_VERSION) return { version: DOLT_VERSION, path: binary, source: 'managed', installed: false };
    try {
      await access(target);
      backup = join(parent, `.replaced-${platform}-${arch}-${process.pid}-${Date.now()}`);
      await rename(target, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { await rename(extracted, target); }
    catch (error) {
      if (backup) await rename(backup, target).catch(() => {});
      throw error;
    }
    if (backup) { await rm(backup, { recursive: true, force: true }); backup = undefined; }
    return { version: DOLT_VERSION, path: binary, source: 'managed', installed: true };
  } finally {
    if (backup) await rename(backup, target).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
