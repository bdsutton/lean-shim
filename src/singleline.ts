// Rewrite a multi-line Lean tactic proof as a single line (pure; no `vscode` import).
//
// Tactics are joined with `; `. Several tactics take a whole tactic *sequence* after them
// (`by`, bullets `·`, `case … =>`, `next =>`, `induction … with | … => …`, `first | …`), and on a
// single line that sequence would swallow everything after it. So any such step that is followed by
// more steps is wrapped in parentheses, which only group tactics (hypotheses introduced inside stay
// available afterwards). Structure is recovered from indentation. Returns undefined when the proof
// can't safely be put on one line (e.g. `calc`, whose steps must be on separate lines).
import { dedent } from './format';

interface Node {
  text: string;
  indent: number;
  children: Node[];
}

/** Remove a `--` line comment (outside string literals). */
function stripLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inString = !inString;
    else if (!inString && c === '-' && line[i + 1] === '-') return line.slice(0, i);
  }
  return line;
}

const BULLET = /^[·.]\s+/;

/** Does this step, when followed by `; more`, need parentheses so it doesn't swallow `more`? */
function needsParens(atom: string): boolean {
  return (
    /(^|[^\w'.])by($|[^\w'])/.test(atom) || // a `by` block
    atom.includes('=>') || // case/next/match alternatives, conv, fun bodies
    /(^|\s)\|(\s|$)/.test(atom) || // `first | a | b`, `with | …`
    BULLET.test(atom) ||
    // combinators whose argument is a tactic sequence: `try simp; exact h` would put `exact h` inside `try`
    /(^|[^\w'.])(try|repeat'?|all_goals|any_goals|focus|iterate|on_goal|classical|with_reducible\w*|with_unfolding_all|set_option)($|[^\w'])/.test(atom)
  );
}

function renderSeq(nodes: Node[]): string {
  // Lines starting with `<;>` continue the previous step; `| alt` lines belong to a preceding `… with`.
  const merged: Node[] = [];
  for (const n of nodes) {
    const prev = merged[merged.length - 1];
    if (prev && n.text.startsWith('<;>')) {
      prev.text = `${renderStep(prev)} ${renderStep(n)}`;
      prev.children = [];
    } else if (prev && n.text.startsWith('|') && /(^|\s)with$|(^|\s)\|/.test(renderStep(prev))) {
      prev.text = `${renderStep(prev)} ${renderStep(n)}`;
      prev.children = [];
    } else {
      merged.push({ ...n, children: [...n.children] });
    }
  }
  const atoms = merged.map(renderStep);
  return atoms.map((a, i) => (i < atoms.length - 1 && needsParens(a) ? `(${a})` : a)).join('; ');
}

function renderStep(node: Node): string {
  const { text, children } = node;
  if (!children.length) return text;

  if (BULLET.test(text)) {
    // The bullet's own tactics: its first tactic plus children at the same column (siblings);
    // deeper children directly after the first tactic continue it.
    const rest = text.replace(BULLET, '');
    const contentCol = node.indent + (text.length - rest.length);
    const cont: Node[] = [];
    let i = 0;
    while (i < children.length && children[i].indent > contentCol) cont.push(children[i++]);
    const seq = renderSeq([{ text: rest, indent: contentCol, children: cont }, ...children.slice(i)]);
    return `· ${seq}`;
  }

  // A tactic block follows (`… := by`, `case h =>`, `next =>`, `conv =>`, `… with`).
  if (/(^|[^\w'.])by$/.test(text) || text.endsWith('=>')) return `${text} ${renderSeq(children)}`;
  if (/(^|\s)with$/.test(text) && children.every((c) => c.text.startsWith('|'))) {
    return `${text} ${children.map(renderStep).join(' ')}`;
  }

  // Otherwise the deeper lines continue this step's term (arguments, `:=` value, `using` term…).
  return [text, ...children.map(renderStep)].join(' ');
}

export function toSingleLine(proof: string): string | undefined {
  const lines = dedent(proof.replace(/\r\n/g, '\n'))
    .split('\n')
    .map((l) => stripLineComment(l).replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  if (!lines.length) return undefined;
  if (lines.some((l) => /(^|[^\w'.])calc($|[^\w'])/.test(l) || l.includes('/-'))) return undefined;
  if (lines.length === 1) return lines[0].trim();

  const root: Node = { text: '', indent: -1, children: [] };
  const stack: Node[] = [root];
  for (const l of lines) {
    const indent = l.length - l.trimStart().length;
    const node: Node = { text: l.trim(), indent, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return renderSeq(root.children);
}
