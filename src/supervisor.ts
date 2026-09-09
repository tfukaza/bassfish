import { fileURLToPath } from 'node:url';
export function entryArgs(command: string, ...args: string[]): string[] {
  const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
  return import.meta.url.endsWith('.ts')
    ? ['--import', 'tsx', entry.replace(/\.js$/, '.ts'), command, ...args]
    : [entry, command, ...args];
}
