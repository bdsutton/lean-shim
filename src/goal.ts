import * as vscode from 'vscode';
import { DECLARATION_START, goalsFromUnsolvedMessage, isUnsolvedGoals } from './format';
import { getLeanClient, LeanClientLike, untilCancelled, withTimeout } from './lean';

/** The goals at the cursor; `goals[0]` is the current goal. */
export interface GoalResult {
  goals: string[];
  /** Where the goals came from, for the log. */
  source: string;
}

const REQUEST_TIMEOUT_MS = 20000;

/** Ask the Lean server for the goals at a position (the same state the infoview shows). */
async function plainGoal(
  client: LeanClientLike,
  doc: vscode.TextDocument,
  pos: vscode.Position,
  token: vscode.CancellationToken,
): Promise<string[] | undefined> {
  try {
    const res = (await Promise.race([untilCancelled(token), withTimeout(
      client.sendRequest(
        '$/lean/plainGoal',
        { textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character } },
        token,
      ),
      REQUEST_TIMEOUT_MS,
    )])) as { goals?: unknown } | null | undefined;
    const goals = Array.isArray(res?.goals) ? res!.goals.filter((g): g is string => typeof g === 'string') : [];
    return goals.length ? goals : undefined;
  } catch {
    return undefined;
  }
}

/** Position just after the last non-whitespace character before `pos` (e.g. the end of `:= by`). */
function afterPrecedingCode(doc: vscode.TextDocument, pos: vscode.Position): vscode.Position | undefined {
  const text = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
  const m = /\S\s*$/.exec(text);
  if (!m) return undefined;
  const p = doc.positionAt(m.index + 1);
  return p.isEqual(pos) ? undefined : p;
}

/**
 * Fallback: the "unsolved goals" error belonging to the proof the cursor is in — the one whose range
 * contains the cursor, else the nearest one starting above it with no new declaration in between.
 */
function goalsFromDiagnostics(doc: vscode.TextDocument, pos: vscode.Position): string[] | undefined {
  const diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => isUnsolvedGoals(d.message));
  const containing = diags.find((d) => d.range.contains(pos));
  if (containing) return goalsFromUnsolvedMessage(containing.message);

  const above = diags
    .filter((d) => d.range.start.isBeforeOrEqual(pos))
    .sort((a, b) => b.range.start.compareTo(a.range.start))[0];
  if (!above) return undefined;
  for (let line = above.range.start.line + 1; line <= pos.line; line++) {
    if (DECLARATION_START.test(doc.lineAt(line).text)) return undefined;
  }
  const goals = goalsFromUnsolvedMessage(above.message);
  return goals.length ? goals : undefined;
}

export async function goalAtCursor(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  token: vscode.CancellationToken,
): Promise<GoalResult | undefined> {
  const client = await getLeanClient();
  if (client) {
    // Tested against the Lean server: asking right after the preceding code (e.g. the end of
    // `:= by`, of the previous tactic, or of a `·` bullet) gives the state the inserted steps start
    // from. Asking at the cursor itself is unreliable when it sits on a blank/indented line (Lean may
    // return nothing, or the state *before* the previous tactic), so that is only the second choice.
    const prev = afterPrecedingCode(doc, pos);
    if (prev) {
      const atPrev = await plainGoal(client, doc, prev, token);
      if (atPrev) return { goals: atPrev, source: `Lean server, after the code ending at line ${prev.line + 1}:${prev.character}` };
    }
    const atCursor = await plainGoal(client, doc, pos, token);
    if (atCursor) return { goals: atCursor, source: 'Lean server, at the cursor' };
  }
  const fromDiag = goalsFromDiagnostics(doc, pos);
  if (fromDiag) return { goals: fromDiag, source: '"unsolved goals" error for this proof' };
  return undefined;
}
