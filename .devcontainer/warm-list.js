#!/usr/bin/env node
// Print (NUL-separated) the prebuilt Lean files that the repo's own .lean files need: everything they
// import, directly or indirectly, including Lean's core library. Used by warm-lean.sh to read those
// files ahead of time so the first file opened in a new Codespace loads quickly.
//
//   LEAN_PREFIX=$(lean --print-prefix) node .devcontainer/warm-list.js [--stats]
//
// Modules are found by their source files: in each package under .lake/packages (prebuilt files in
// <package>/.lake/build/lib/lean) and in the Lean toolchain (sources in <prefix>/src/lean, prebuilt
// files in <prefix>/lib/lean).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const prefix = process.env.LEAN_PREFIX || '';
const stats = process.argv.includes('--stats');

// Where to look for a module's source, and where its prebuilt files live.
const places = [];
if (prefix) places.push({ src: path.join(prefix, 'src', 'lean'), build: path.join(prefix, 'lib', 'lean') });
const pkgDir = path.join(root, '.lake', 'packages');
for (const name of fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir) : []) {
  const dir = path.join(pkgDir, name);
  places.push({ src: dir, build: path.join(dir, '.lake', 'build', 'lib', 'lean') });
}
places.push({ src: root, build: path.join(root, '.lake', 'build', 'lib', 'lean') });

function locate(mod) {
  const rel = mod.split('.').join(path.sep) + '.lean';
  for (const p of places) {
    const src = path.join(p.src, rel);
    if (fs.existsSync(src)) return { src, build: path.join(p.build, mod.split('.').join(path.sep)) };
  }
  return undefined;
}

// The import header: `import`/`public import`/`meta import` lines before the first other command.
const IMPORT = /^\s*(?:(?:public|private|meta)\s+)*import\s+(?:all\s+)?([\w.«»']+)/;
function imports(file) {
  const out = [];
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
    if (t === '') continue;
    if (t === 'module') continue;
    if (t === 'prelude') {
      isPrelude = true;
      continue;
    }
    const m = IMPORT.exec(t);
    if (!m) break;
    out.push(m[1]);
  }
  return { mods: out, isPrelude };
}

// The repo's own .lean files (not dependencies or build output).
function projectFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.lake' || e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) projectFiles(p, acc);
    else if (e.name.endsWith('.lean')) acc.push(p);
  }
  return acc;
}

const seen = new Set();
const stack = [];
for (const f of projectFiles(root)) {
  const { mods, isPrelude } = imports(f);
  stack.push(...mods);
  if (!isPrelude) stack.push('Init'); // every non-prelude file imports Init
}
let unresolved = 0;
const files = [];
while (stack.length) {
  const mod = stack.pop();
  if (seen.has(mod)) continue;
  seen.add(mod);
  const loc = locate(mod);
  if (!loc) {
    // No source (e.g. Lake's modules, which the toolchain ships prebuilt only): still read the
    // prebuilt file if the toolchain has it, though its own imports can't be followed.
    const core = prefix ? path.join(prefix, 'lib', 'lean', mod.split('.').join(path.sep)) : '';
    const have = core && ['.olean', '.ilean'].map((e) => core + e).filter((f) => fs.existsSync(f));
    if (have && have.length) files.push(...have);
    else unresolved++;
    continue;
  }
  const { mods, isPrelude } = imports(loc.src);
  stack.push(...mods);
  if (!isPrelude && mod !== 'Init' && !mod.startsWith('Init.')) stack.push('Init');
  for (const ext of ['.olean', '.ilean']) {
    const f = loc.build + ext;
    if (fs.existsSync(f)) files.push(f);
  }
}

if (stats) {
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  process.stderr.write(
    `${seen.size - unresolved} modules (${unresolved} not found), ${files.length} prebuilt files, ${(bytes / 1e6).toFixed(0)} MB\n`,
  );
}
process.stdout.write(files.map((f) => f + '\0').join(''));
