// Pure text helpers (no `vscode` import) so they can be unit-tested with plain Node.

/** Extract the proof text from a model reply: drop code fences and surrounding prose. */
export function extractProof(reply: string): string {
  let text = reply.replace(/\r\n/g, '\n');

  // If the model used a fenced code block, keep only the first block's contents.
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  if (fence) {
    text = fence[1];
  } else {
    // Unterminated fence (e.g. truncated stream).
    text = text.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
  }

  // Drop blank lines at the start/end, keep internal structure.
  const lines = text.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}

/** Remove the indentation common to every non-blank line. */
export function dedent(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!isFinite(min) || min === 0) return text;
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(min))).join('\n');
}

/**
 * Work out the exact text to insert at the cursor so the suggestion lines up
 * with the surrounding Lean code.
 *
 * @param proof      the dedented proof steps from the model
 * @param linePrefix text on the cursor's line before the cursor
 * @param eol        the document's line ending
 * @param tabSize    spaces per indent level for a fresh block
 */
export function layoutInsertion(proof: string, linePrefix: string, eol: string, tabSize = 2): string {
  const lines = dedent(proof).split('\n');
  const prefixIsBlank = linePrefix.trim() === '';

  if (prefixIsBlank) {
    // Cursor is in the indentation of an (otherwise empty-before-cursor) line:
    // the first line goes right at the cursor, later lines share its column.
    const indent = linePrefix.replace(/[^\t ]/g, ' ');
    return lines.map((l, i) => (i === 0 || l === '' ? l : indent + l)).join(eol);
  }

  // Cursor follows code on the same line (e.g. right after `:= by`).
  if (lines.length === 1) {
    const sep = /\s$/.test(linePrefix) ? '' : ' ';
    return sep + lines[0];
  }
  const baseIndent = (/^[\t ]*/.exec(linePrefix)?.[0] ?? '') + ' '.repeat(tabSize);
  return lines.map((l) => eol + (l === '' ? '' : baseIndent + l)).join('');
}

export const CURSOR_MARK = '<<<FILL_HERE>>>';

export interface PromptInput {
  /** File text before the cursor (with any previous suggestion removed). */
  before: string;
  /** File text after the cursor (with any previous suggestion removed). */
  after: string;
  /** Max lines of context to send. */
  contextLines: number;
  /** Lean diagnostics worth showing the model. */
  diagnostics: string[];
  /** Suggestions already rejected by the user at this spot. */
  rejected: string[];
  extraInstructions: string;
}

/** Trim the file to a window around the cursor, always keeping the header (imports/opens). */
export function contextWindow(before: string, after: string, maxLines: number): string {
  const b = before.split('\n');
  const a = after.split('\n');
  if (b.length + a.length <= maxLines) return before + CURSOR_MARK + after;

  const headerLen = Math.min(30, Math.floor(maxLines / 5));
  const header = b.slice(0, headerLen);
  const budget = maxLines - headerLen;
  const afterBudget = Math.min(a.length, Math.floor(budget / 3));
  const beforeBudget = budget - afterBudget;

  const bStart = Math.max(headerLen, b.length - beforeBudget);
  const parts: string[] = [];
  parts.push(header.join('\n'));
  if (bStart > headerLen) parts.push('\n-- … (lines omitted) …\n');
  else if (headerLen < b.length) parts.push('\n');
  parts.push(b.slice(bStart).join('\n'));
  parts.push(CURSOR_MARK);
  parts.push(a.slice(0, afterBudget).join('\n'));
  if (afterBudget < a.length) parts.push('\n-- … (lines omitted) …');
  return parts.join('');
}

export function buildPrompt(input: PromptInput): string {
  const file = contextWindow(input.before, input.after, input.contextLines);
  const out: string[] = [];
  out.push(
    'You are an expert in the Lean 4 theorem prover and Mathlib.',
    `Below is a Lean 4 file. The marker ${CURSOR_MARK} shows where the user's cursor is.`,
    'A proof (or part of a proof) is missing at that position. Write ONLY the Lean code that should be',
    'inserted at the marker so that the surrounding proof is complete and compiles.',
    '',
    'Rules:',
    '- Output only the code to insert: no explanation, no restating the theorem, no surrounding code.',
    '- Do not repeat text that already appears immediately before or after the marker',
    '  (for example, if the marker follows `:= by`, do not write `by` again).',
    '- Do not use `sorry`, `admit`, or `native_decide` unless the user\'s file already relies on them.',
    '- Use tactic steps one per line when inside a `by` block; use consistent relative indentation.',
    '- Only use lemmas you are confident exist in Lean 4 / current Mathlib.',
    '- Put the code in a single ```lean code block.',
  );
  if (input.extraInstructions.trim()) {
    out.push('', 'Additional instructions from the user:', input.extraInstructions.trim());
  }
  out.push('', '```lean', file, '```');
  if (input.diagnostics.length) {
    out.push('', 'Current Lean messages near the cursor (these may include the goal state):');
    for (const d of input.diagnostics) out.push(d);
  }
  if (input.rejected.length) {
    out.push(
      '',
      'The user rejected the following suggestions for this spot. Produce a genuinely DIFFERENT proof',
      '(different approach or tactics), and avoid any errors reported above for them:',
    );
    input.rejected.forEach((r, i) => out.push(`Rejected suggestion ${i + 1}:`, '```lean', r, '```'));
  }
  return out.join('\n');
}
