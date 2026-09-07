import { increment, requireThat } from './domain.js';
import type { Actor, Note, NoteMutation, ResourceLink } from './domain.js';

export const normalizeLabels = (labels: string[]): string[] => {
  const sorted = [...labels].sort();
  requireThat(new Set(sorted).size === sorted.length, 'INVALID_ARGUMENT', 'Note labels must be unique.');
  return sorted;
};

export const normalizeLinks = (links: ResourceLink[]): ResourceLink[] => {
  const sorted = [...links].sort((a, b) => `${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`));
  requireThat(new Set(sorted.map(link => `${link.targetType}:${link.targetId}`)).size === sorted.length, 'INVALID_ARGUMENT', 'Resource links must be unique.');
  return sorted;
};

function applyUnifiedPatch(body: string, patch: string): string {
  const rows = patch.replaceAll('\r\n', '\n').split('\n');
  requireThat(rows.filter(row => row.startsWith('--- ')).length <= 1 && rows.filter(row => row.startsWith('+++ ')).length <= 1, 'PATCH_REJECTED', 'A patch may contain only one file section.');
  requireThat(!rows.some(row => /^(rename (from|to)|new file mode|deleted file mode)/.test(row)), 'PATCH_REJECTED', 'File creation, deletion, and rename patches are not supported.');
  const source = body.split('\n');
  const output: string[] = [];
  let sourceIndex = 0;
  let index = 0;
  while (index < rows.length && !rows[index]!.startsWith('@@ ')) index++;
  requireThat(index < rows.length, 'PATCH_REJECTED', 'The unified patch contains no hunks.');
  while (index < rows.length) {
    const header = rows[index++]!;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    requireThat(match, 'PATCH_REJECTED', 'A patch hunk header is invalid.');
    const oldStart = Number(match[1]) - 1;
    requireThat(oldStart >= sourceIndex && oldStart <= source.length, 'PATCH_REJECTED', 'A patch hunk is out of order or out of range.');
    output.push(...source.slice(sourceIndex, oldStart)); sourceIndex = oldStart;
    let removed = 0; let added = 0;
    while (index < rows.length && !rows[index]!.startsWith('@@ ')) {
      const row = rows[index++]!;
      if (row === '\\ No newline at end of file' || (index === rows.length && row === '')) continue;
      const marker = row[0]; const text = row.slice(1);
      requireThat(marker === ' ' || marker === '+' || marker === '-', 'PATCH_REJECTED', 'A patch hunk line is invalid.');
      if (marker === ' ' || marker === '-') {
        requireThat(source[sourceIndex] === text, 'PATCH_REJECTED', 'Patch context does not exactly match the claimed revision.');
        if (marker === ' ') output.push(text);
        sourceIndex++; removed++;
      }
      if (marker === '+') { output.push(text); added++; }
    }
    requireThat(removed === Number(match[2] ?? 1) && added === Number(match[4] ?? 1), 'PATCH_REJECTED', 'Patch hunk counts do not match its header.');
  }
  output.push(...source.slice(sourceIndex));
  return output.join('\n');
}

function applyOne(note: Note, mutation: Exclude<NoteMutation, { kind: 'batchNote' }>): Note {
  const next = structuredClone(note);
  const contentEdit = ['replaceNoteBody','patchNoteBody','appendNoteBody','prependNoteBody','replaceNoteText','upsertNoteSection','moveNote','setNoteMetadata','setLinks'].includes(mutation.kind);
  requireThat(!contentEdit || note.state === 'active', 'RESOURCE_ARCHIVED', 'Restore the note before editing it.');
  switch (mutation.kind) {
    case 'replaceNoteBody': next.body = mutation.body; break;
    case 'patchNoteBody': next.body = applyUnifiedPatch(note.body, mutation.patch); break;
    case 'appendNoteBody': next.body += mutation.body; break;
    case 'prependNoteBody': next.body = mutation.body + next.body; break;
    case 'moveNote': next.path = mutation.path; break;
    case 'setNoteMetadata':
      requireThat(mutation.title !== undefined || mutation.labels !== undefined || mutation.noteKind !== undefined, 'INVALID_ARGUMENT', 'Set at least one metadata field.');
      if (mutation.title !== undefined) next.title = mutation.title;
      if (mutation.labels !== undefined) next.labels = normalizeLabels(mutation.labels);
      if (mutation.noteKind !== undefined) next.kind = mutation.noteKind;
      break;
    case 'setLinks': next.links = normalizeLinks(mutation.links); break;
    case 'archiveNote': requireThat(note.state === 'active', 'NO_CHANGE', 'Only an active note can be archived.'); next.state = 'archived'; break;
    case 'deleteNote': requireThat(note.state !== 'deleted', 'NO_CHANGE', 'The note is already deleted.'); next.state = 'deleted'; break;
    case 'activateNote': requireThat(note.state !== 'active', 'NO_CHANGE', 'The note is already active.'); next.state = 'active'; break;
    case 'replaceNoteText': {
      const count = note.body.split(mutation.find).length - 1;
      requireThat(count === mutation.expectedOccurrences, 'OCCURRENCE_MISMATCH', 'The expected occurrence count does not match the claimed body.',);
      next.body = note.body.split(mutation.find).join(mutation.replace); break;
    }
    case 'upsertNoteSection': {
      const headings = outline(note.body); const matches = headings.filter(item => item.path.join('\u0000') === mutation.headingPath.join('\u0000'));
      if (!matches.length) {
        requireThat(mutation.createIfMissing, 'SECTION_NOT_FOUND', 'The requested Markdown section does not exist.');
        const suffix = `${note.body && !note.body.endsWith('\n') ? '\n' : ''}\n${mutation.headingPath.map((heading,index) => `${'#'.repeat(index + 1)} ${heading}`).join('\n\n')}\n\n${mutation.body}`;
        next.body += suffix;
      } else {
        requireThat(matches.length === 1 || mutation.occurrence !== undefined, 'SECTION_AMBIGUOUS', 'The heading path is ambiguous; provide an occurrence.');
        const match = matches[(mutation.occurrence ?? 1) - 1]; requireThat(match, 'SECTION_NOT_FOUND', 'The heading occurrence does not exist.');
        const lines = note.body.split('\n'); const heading = lines[match.startLine - 1]!;
        lines.splice(match.startLine - 1, match.endLine - match.startLine + 1, heading, mutation.body);
        next.body = lines.join('\n');
      }
      break;
    }
  }
  requireThat(Buffer.byteLength(next.body, 'utf8') <= 256 * 1024, 'CONTENT_TOO_LARGE', 'The resulting note exceeds 256 KiB.');
  return next;
}

export interface OutlineItem { level: number; heading: string; path: string[]; startLine: number; endLine: number }
export function outline(body: string): OutlineItem[] {
  const lines = body.split('\n'); const items: OutlineItem[] = []; const stack: string[] = []; let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; const marker = /^ {0,3}(```+|~~~+)/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = undefined; continue; }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const setext = index + 1 < lines.length ? /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1]!) : null;
    const level = atx ? atx[1]!.length : setext && line.trim() ? (setext[1]![0] === '=' ? 1 : 2) : 0;
    if (!level) continue; const heading = (atx ? atx[2] : line.trim())!; stack.length = level - 1; stack[level - 1] = heading;
    items.push({ level, heading, path: [...stack], startLine: index + 1, endLine: lines.length }); if (!atx) index++;
  }
  for (let index = 0; index < items.length; index++) { const next = items.slice(index + 1).find(item => item.level <= items[index]!.level); if (next) items[index]!.endLine = next.startLine - 1; }
  return items;
}

export function prepareNote(note: Note, mutation: NoteMutation, actor: Actor, at: string): Note {
  let next = structuredClone(note);
  if (mutation.kind === 'batchNote') for (const item of mutation.mutations) next = applyOne(next, item);
  else next = applyOne(next, mutation);
  const comparable = (value: Note) => JSON.stringify({ ...value, revision: 'x', lastEditor: 'x', lastEditorName: 'x', updatedAt: 'x' });
  requireThat(comparable(next) !== comparable(note), 'NO_CHANGE', 'The note mutation makes no change.');
  next.revision = increment(note.revision); next.lastEditor = actor.identityId; next.lastEditorName = actor.name; next.updatedAt = at;
  return next;
}
