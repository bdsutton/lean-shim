// Timeline of what the Lean server is doing when it starts and when it first processes each file
// (pure; no `vscode` import, so it can be unit-tested). Fed by the Lean 4 extension's events.
//
// Phases:
//   1. Server start: choosing the Lean version (elan), launching `lake serve` (which checks the
//      project's dependencies and clones any that are missing), and connecting. Measured from the
//      Lean extension's "restarting" event to its "restarted" event.
//   2. Per file, loading imports: Lean reports the whole file as "still processing" from line 0 while
//      it prepares and loads the imports (`lake setup-file`, building out-of-date project modules,
//      loading .olean files such as Mathlib's).
//   3. Per file, checking: the start of the still-processing range steps through the file one
//      declaration at a time; how long it stays on a line is how long that declaration took.

export interface ProcessingInfo {
  range: { start: { line: number }; end: { line: number } };
  kind?: number; // 1 = processing, 2 = fatal error
}

export interface TrackerDeps {
  log(line: string): void;
  now(): number;
  /** Text of the document, if it's open (used to find the import header and name slow lines). */
  docText(uri: string): string | undefined;
  /** Short name for the file in the log. */
  fileName(uri: string): string;
}

/** Index of the last line of the import header (`import …`, `module`, `prelude`), or -1. */
export function lastImportLine(text: string): number {
  const lines = text.split('\n');
  let last = -1;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].trim();
    if (inBlockComment) {
      const end = t.indexOf('-/');
      if (end < 0) continue;
      inBlockComment = false;
      t = t.slice(end + 2).trim();
    }
    if (t.startsWith('/-')) {
      if (!t.slice(2).includes('-/')) inBlockComment = true;
      continue;
    }
    if (t === '' || t.startsWith('--')) continue;
    if (/^((public|private|meta)\s+)*import\s/.test(t) || t === 'module' || t === 'prelude') {
      last = i;
      continue;
    }
    break;
  }
  return last;
}

interface FileState {
  start: number;
  headerLast: number;
  initialFrontier: number;
  importsDone?: number;
  frontier?: number;
  frontierSince?: number;
  slow: { line: number; ms: number }[];
  startedBeforeTracking: boolean;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export class StartupTracker {
  private serverStart?: number;
  private serverReadyLogged = false;
  private files = new Map<string, FileState>();
  private finished = new Set<string>();

  constructor(private readonly deps: TrackerDeps) {}

  private log(msg: string) {
    this.deps.log(`[${new Date(this.deps.now()).toLocaleTimeString()}] ${msg}`);
  }

  /** The Lean extension already had a running/starting server when tracking began. */
  alreadyStarted(running: boolean) {
    this.log(
      running
        ? 'Lean server was already running when Lean Proof Fill loaded; its start-up was not timed (run "Lean 4: Restart Server" to time it).'
        : 'Lean server was already starting when Lean Proof Fill loaded; timing from now.',
    );
    if (!running) {
      this.serverStart = this.deps.now();
      this.serverReadyLogged = false;
    }
  }

  serverStarting() {
    this.serverStart = this.deps.now();
    this.serverReadyLogged = false;
    this.files.clear();
    this.finished.clear();
    this.log(
      'Lean server starting: choosing the Lean version (elan), launching `lake serve` (checks the project ' +
        'dependencies and clones any that are missing), connecting…',
    );
  }

  serverReady() {
    if (this.serverReadyLogged) return; // the Lean extension reports "restarted" more than once
    this.serverReadyLogged = true;
    this.log(this.serverStart !== undefined ? `Lean server ready after ${secs(this.deps.now() - this.serverStart)}.` : 'Lean server ready.');
  }

  serverFailed(message: string) {
    this.log(`Lean server failed to start: ${message}`);
  }

  serverStopped(message: string) {
    this.log(`Lean server stopped${message ? `: ${message}` : ''}.`);
  }

  progress(uri: string, infos: ProcessingInfo[]) {
    if (this.finished.has(uri)) return; // only the first full processing of each file is timed
    const now = this.deps.now();
    const name = this.deps.fileName(uri);
    let st = this.files.get(uri);
    const frontier = infos.length ? Math.min(...infos.map((i) => i.range.start.line)) : Infinity;

    if (!st) {
      const text = this.deps.docText(uri);
      const headerLast = text !== undefined ? lastImportLine(text) : -1;
      st = {
        start: now,
        headerLast,
        initialFrontier: frontier,
        slow: [],
        // If processing is already past the imports, we joined late and can't time them.
        startedBeforeTracking: frontier !== 0 || infos.length > 1,
      };
      this.files.set(uri, st);
      this.log(
        st.startedBeforeTracking
          ? `${name}: Lean was already processing this file when tracking began; timing from now.`
          : `${name}: Lean started processing the file — loading imports${headerLast >= 0 ? ` (lines 1–${headerLast + 1})` : ''}…`,
      );
      if (st.startedBeforeTracking) st.importsDone = now;
    }

    const fatal = infos.find((i) => i.kind === 2);
    if (fatal) {
      this.log(`${name}: Lean stopped with a fatal error at line ${fatal.range.start.line + 1} after ${secs(now - st.start)}.`);
      this.finish(uri, st, now, true);
      return;
    }

    // Imports are loaded once the still-processing part starts after the import header.
    if (st.importsDone === undefined) {
      const pastHeader = st.headerLast >= 0 ? frontier > st.headerLast : frontier !== st.initialFrontier || infos.length !== 1;
      if (!infos.length || pastHeader) {
        st.importsDone = now;
        this.log(`${name}: imports loaded after ${secs(now - st.start)}.`);
      }
    }

    // While checking, time how long the processing frontier stays on each line.
    if (st.importsDone !== undefined) {
      if (st.frontier === undefined) {
        st.frontier = frontier;
        st.frontierSince = now;
      } else if (frontier !== st.frontier) {
        st.slow.push({ line: st.frontier, ms: now - st.frontierSince! });
        st.frontier = frontier;
        st.frontierSince = now;
      }
    }

    if (!infos.length) this.finish(uri, st, now, false);
  }

  private finish(uri: string, st: FileState, now: number, fatal: boolean) {
    this.finished.add(uri);
    this.files.delete(uri);
    const name = this.deps.fileName(uri);
    const total = now - st.start;
    const imports = (st.importsDone ?? now) - st.start;
    const checking = now - (st.importsDone ?? now);
    const parts = st.startedBeforeTracking
      ? `${secs(total)} from when tracking began`
      : `${secs(total)} in total: loading imports ${secs(imports)}, checking the file ${secs(checking)}`;
    this.log(`${name}: ${fatal ? 'stopped' : 'finished'} — ${parts}.`);

    const text = this.deps.docText(uri);
    const lines = text?.split('\n');
    const slowest = st.slow
      .filter((s) => Number.isFinite(s.line) && s.ms >= 50)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3);
    if (slowest.length) {
      this.deps.log('    slowest parts of the file:');
      for (const s of slowest) {
        const src = lines?.[s.line]?.trim().slice(0, 80) ?? '';
        this.deps.log(`      line ${s.line + 1}: ${secs(s.ms)}${src ? `  ${src}` : ''}`);
      }
    }
  }
}

/** What Lean is doing with a file, from its latest progress report (for a "please wait" message). */
export function describeLeanActivity(infos: ProcessingInfo[] | undefined, text: string): string {
  if (!infos) return 'Lean is still processing this file';
  if (!infos.length) return 'Lean is just finishing this file';
  const fatal = infos.find((i) => i.kind === 2);
  if (fatal) return `Lean stopped with an error at line ${fatal.range.start.line + 1}`;
  const frontier = Math.min(...infos.map((i) => i.range.start.line));
  const header = lastImportLine(text);
  const total = text.split('\n').length;
  const loadingImports = header >= 0 ? frontier <= header : frontier === 0 && infos.length === 1;
  if (loadingImports) return "Lean is still loading this file's imports (with Mathlib this can take a minute or more)";
  return `Lean is still checking this file (line ${frontier + 1} of ${total})`;
}
