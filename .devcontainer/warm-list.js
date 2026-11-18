#!/usr/bin/env node
// List, in the order Lean needs them, the files that make the first Lean start in a new Codespace
// slow: a Codespace created from a prebuild fetches each file's data the first time it is read, at
// only a few MB/s. warm-lean.sh reads these files ahead of time.
//
//   LEAN_PREFIX=$(lean --print-prefix) node .devcontainer/warm-list.js <phase> [--stats]
//
// Phases (each prints NUL-separated paths):
//   small  — files Lake reads before Lean loads anything: lakefiles/manifests of the project and its
//            packages, and the source, .trace and .hash files of every module the repo's .lean files
//            import (directly or indirectly). Many tiny files.
//   olean  — the prebuilt .olean files of those modules, dependencies first (the order Lean loads them).
// (Lean's own program and libraries are listed by warm-lean.sh. .ilean index files are left out: the
// Lean server reads all of them itself, in the background.)
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const prefix = process.env.LEAN_PREFIX || '';
const phase = process.argv[2];
const stats = process.argv.includes('--stats');
if (phase !== 'small' && phase !== 'olean') {
  process.stderr.write('usage: warm-list.js small|olean [--stats]\n');
  process.exit(2);
}

// Where to look for a module's source, and where its build outputs live.
const places = [];
if (prefix) places.push({ src: path.join(prefix, 'src', 'lean'), build: path.join(prefix, 'lib', 'lean') });
const pkgRoot = path.join(root, '.lake', 'packages');
const pkgs = fs.existsSync(pkgRoot) ? fs.readdirSync(pkgRoot).map((n) => path.join(pkgRoot, n)) : [];
for (const dir of pkgs) places.push({ src: dir, build: path.join(dir, '.lake', 'build', 'lib', 'lean') });
places.push({ src: root, build: path.join(root, '.lake', 'build', 'lib', 'lean') });

const relOf = (mod) => mod.split('.').join(path.sep);
function locate(mod) {
  for (const p of places) {
    const src = path.join(p.src, relOf(mod) + '.lean');
    if (fs.existsSync(src)) return { src, build: path.join(p.build, relOf(mod)) };
  }
  // No source (e.g. Lake's modules, which the toolchain ships prebuilt only).
  if (prefix) {
    const build = path.join(prefix, 'lib', 'lean', relOf(mod));
    if (fs.existsSync(build + '.olean')) return { src: undefined, build };
  }
  return undefined;
}

// The import header: `import`/`public import`/`meta import` lines before the first other command.
const IMPORT = /^\s*(?:(?:public|private|meta)\s+)*import\s+(?:all\s+)?([\w.«»']+)/;
function header(file) {
  const mods = [];
  let inComment = false;
  let isPrelude = false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    let t = raw.trim();
    if (inComment) {
      const end = t.indexOf('-/');
      if (end < 0) continue;
      inComment = false;
      t = t.slice(end + 2).trim();
    }
    if (t.startsWith('/-')) {
      if (!t.slice(2).includes('-/')) inComment = true;
      continue;
    }
    t = t.replace(/--.*$/, '').trim();
    if (t === '' || t === 'module') continue;
    if (t === 'prelude') {
      isPrelude = true;
      continue;
    }
    const m = IMPORT.exec(t);
    if (!m) break;
    mods.push(m[1]);
  }
  return { mods, isPrelude };
}

function projectFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.lake' || e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) projectFiles(p, acc);
    else if (e.name.endsWith('.lean')) acc.push(p);
  }
  return acc;
}

// Depth-first walk of the import graph, emitting each module after its imports (dependencies first).
const order = [];
const state = new Map(); // module -> 'visiting' | 'done'
let unresolved = 0;
function visit(start) {
  const stack = [[start, null]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [mod] = top;
    if (top[1] === null) {
      if (state.has(mod)) {
        stack.pop();
        continue;
      }
      state.set(mod, 'visiting');
      const loc = locate(mod);
      if (!loc) unresolved++;
      const deps = [];
      if (loc && loc.src) {
        const h = header(loc.src);
        deps.push(...h.mods);
        if (!h.isPrelude && mod !== 'Init' && !mod.startsWith('Init.')) deps.push('Init');
      }
      top[1] = { loc, deps, i: 0 };
    }
    const info = top[1];
    if (info.i < info.deps.length) {
      const dep = info.deps[info.i++];
      if (!state.has(dep)) stack.push([dep, null]);
      continue;
    }
    state.set(mod, 'done');
    if (info.loc) order.push(info.loc);
    stack.pop();
  }
}
for (const f of projectFiles(root)) {
  const h = header(f);
  for (const m of h.mods) visit(m);
  if (!h.isPrelude) visit('Init'); // every non-prelude file imports Init
}

const exists = (f) => fs.existsSync(f);
let files = [];
if (phase === 'small') {
  for (const dir of [root, ...pkgs]) {
    for (const f of ['lakefile.toml', 'lakefile.lean', 'lake-manifest.json', 'lean-toolchain']) files.push(path.join(dir, f));
    for (const f of ['lakefile.olean', 'lakefile.olean.lock', 'packages']) files.push(path.join(dir, '.lake', f));
  }
  for (const loc of order) {
    if (loc.src) files.push(loc.src);
    files.push(loc.build + '.trace', loc.build + '.olean.hash', loc.build + '.ilean.hash');
  }
} else {
  files = order.map((loc) => loc.build + '.olean');
}
files = files.filter((f) => exists(f) && fs.statSync(f).isFile());

if (stats) {
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  process.stderr.write(
    `${phase}: ${files.length} files, ${(bytes / 1e6).toFixed(0)} MB (${order.length} modules, ${unresolved} not found)\n`,
  );
}
process.stdout.write(files.map((f) => f + '\0').join(''));
