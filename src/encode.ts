// Pure helpers for storing an accepted proof as a `from_base64 "..."` call (no `vscode` import).
import { dedent } from './format';

/** Base64-encode proof text (UTF-8), matching Lean's `LeanShim.Base64.decode`. */
export function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** The tactic call that reproduces `proof`. The proof is dedented so decoding yields column-0 tactics. */
export function tacticCall(proof: string): string {
  const lines = dedent(proof).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return `from_base64 "${toBase64(lines.join('\n'))}"`;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is `module` already imported by the file? */
export function hasImport(fileText: string, module: string): boolean {
  const re = new RegExp(`^[ \\t]*import[ \\t]+${escapeForRegex(module)}[ \\t]*(--.*)?$`, 'm');
  return re.test(fileText);
}

/**
 * Offset at which to insert a new `import` line: at the start of the line after the last existing
 * top-of-file import, else at the very top. (Lean requires all imports before any other command.)
 */
export function importInsertOffset(fileText: string): number {
  const lines = fileText.split('\n');
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('import ')) lastImportLine = i;
    else if (t === '' || t.startsWith('--')) continue;
    else break; // first real command: imports must come before it
  }
  let offset = 0;
  for (let i = 0; i <= lastImportLine; i++) offset += lines[i].length + 1; // +1 for the '\n'
  return offset;
}
