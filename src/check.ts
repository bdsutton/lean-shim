// Pure decision logic for "did Lean accept the suggestion?" (no `vscode` import, so it's unit-testable).
import { goalsFromUnsolvedMessage, isUnsolvedGoals } from './format';

export interface Pos {
  line: number;
  character: number;
}
export interface Span {
  start: Pos;
  end: Pos;
}
export interface Diag {
  severity: 'error' | 'warning' | 'other';
  message: string;
  range: Span;
}

export const SORRY_WARNING = /declaration uses [`']?sorry/;
const FORBIDDEN = /(^|[^\w.'])(sorry|admit)(?![\w'])/;

/** `sorry`/`admit` in the suggested text itself (Lean only warns about these, so check explicitly). */
export function usesSorry(text: string): boolean {
  return text.split('\n').some((l) => FORBIDDEN.test(l.replace(/--.*$/, '')));
}

function cmp(a: Pos, b: Pos): number {
  return a.line - b.line || a.character - b.character;
}
/** True if the spans overlap or touch. */
export function touches(a: Span, b: Span): boolean {
  return cmp(a.start, b.end) <= 0 && cmp(b.start, a.end) <= 0;
}

/** The part of the file Lean must accept: the declaration containing the insertion. */
export interface Region {
  startLine: number;
  /** First line after the declaration (exclusive). */
  endLine: number;
}

export function inRegion(d: Diag, region: Region, inserted: Span): boolean {
  return (d.range.start.line >= region.startLine && d.range.start.line < region.endLine) || touches(d.range, inserted);
}

/**
 * The declaration's errors (and whether it had a sorry warning) before the current insertion,
 * with positions relative to the document in which our own text occupied `anchor`
 * (an empty span at the cursor for a fresh insertion).
 */
export interface Baseline {
  errors: { message: string; range: Span }[];
  hadSorryWarning: boolean;
  anchor: Span;
}

const norm = (g: string) => g.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();

/**
 * Is this the error that belongs to the gap being filled? Lean reports an unfinished proof as
 * "unsolved goals" on the enclosing `by`; that message stays identical (text and position) when a
 * suggestion does nothing, so it can never be treated as a pre-existing, unrelated error. It is
 * recognised by listing the goal at the cursor. If that goal is unknown, every "unsolved goals"
 * error is assumed to belong to the gap.
 */
export function isHoleError(message: string, holeGoal: string | undefined): boolean {
  if (!isUnsolvedGoals(message)) return false;
  if (!holeGoal) return true;
  const g = norm(holeGoal);
  return goalsFromUnsolvedMessage(message).some((x) => norm(x) === g);
}

export function makeBaseline(diags: Diag[], region: Region, anchor: Span, holeGoal?: string): Baseline {
  const inDecl = diags.filter((d) => inRegion(d, region, anchor));
  return {
    errors: inDecl
      .filter((d) => d.severity === 'error' && !isHoleError(d.message, holeGoal))
      .map((d) => ({ message: d.message, range: d.range })),
    hadSorryWarning: inDecl.some((d) => d.severity === 'warning' && SORRY_WARNING.test(d.message)),
    anchor,
  };
}

/** Where a position from the baseline document ends up after `anchor` was replaced by `now`. */
export function mapPos(p: Pos, anchor: Span, now: Span): Pos {
  if (cmp(p, anchor.start) < 0) return p;
  if (cmp(p, anchor.end) < 0) return now.start; // inside our old text
  if (p.line === anchor.end.line) {
    return { line: now.end.line, character: now.end.character + (p.character - anchor.end.character) };
  }
  return { line: p.line + (now.end.line - anchor.end.line), character: p.character };
}

const sameSpan = (a: Span, b: Span) => cmp(a.start, b.start) === 0 && cmp(a.end, b.end) === 0;

export interface Verdict {
  ok: boolean;
  /** Problems to report (and to feed back to the model). */
  problems: Diag[];
  /** Pre-existing errors elsewhere in the declaration that were ignored. */
  tolerated: number;
}

/**
 * Decide whether Lean accepted the inserted text.
 *
 * Every error in the declaration counts against the suggestion, except a pre-existing, unrelated
 * one: the same message at the same place (positions shifted to account for the inserted text),
 * not touching the inserted text, and not the gap's own "unsolved goals" error (see `isHoleError`;
 * those are left out of the baseline). A `sorry` warning that wasn't there before also counts.
 */
export function judge(diags: Diag[], region: Region, inserted: Span, baseline: Baseline): Verdict {
  const pool = baseline.errors.map((e) => ({
    message: e.message,
    range: { start: mapPos(e.range.start, baseline.anchor, inserted), end: mapPos(e.range.end, baseline.anchor, inserted) },
  }));
  const problems: Diag[] = [];
  let tolerated = 0;
  for (const d of diags) {
    if (!inRegion(d, region, inserted)) continue;
    if (d.severity === 'warning' && SORRY_WARNING.test(d.message) && !baseline.hadSorryWarning) {
      problems.push(d);
      continue;
    }
    if (d.severity !== 'error') continue;
    const i = touches(d.range, inserted) ? -1 : pool.findIndex((e) => e.message === d.message && sameSpan(e.range, d.range));
    if (i >= 0) {
      pool.splice(i, 1);
      tolerated++;
      continue;
    }
    problems.push(d);
  }
  return { ok: problems.length === 0, problems, tolerated };
}

/** One-line-ish description of a problem for the log and the model. */
export function describe(d: Diag, lineText: string): string {
  const msg = isUnsolvedGoals(d.message)
    ? 'unsolved goals (the suggestion did not finish the proof)'
    : d.message.trim();
  const ind = msg.split('\n').map((l) => '    ' + l).join('\n');
  return `- at line ${d.range.start.line + 1} \`${lineText.trim().slice(0, 100)}\`:\n${ind}`;
}
