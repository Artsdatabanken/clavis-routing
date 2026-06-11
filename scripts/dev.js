#!/usr/bin/env node

/**
 * Local development orchestrator.
 *
 * One command from the routing repo brings up the whole Clavis ecosystem:
 *   - clavis-viewer-web in watch mode (rebuilds dist on save)
 *   - a dist watcher that copies viewer-web's dist into both consumers'
 *     node_modules so CRA dev servers see changes
 *   - clavis-routing/viewer  CRA dev server on PORT 3000
 *   - Clavis-editor          CRA dev server on PORT 3001
 *   - clavis-routing express server on PORT 5000 in dev mode, proxying
 *     /viewer/* and /editor/* (incl. websockets) to the CRA dev servers
 *
 * Open http://localhost:5000/ — both /viewer and /editor are live,
 * any source change anywhere in the three repos propagates with HMR.
 *
 * Expects the three repos to live as siblings:
 *   <parent>/clavis-viewer-web
 *   <parent>/Clavis-editor
 *   <parent>/clavis-routing
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROUTING = path.resolve(__dirname, '..');
const PARENT = path.resolve(ROUTING, '..');
const VIEWER_WEB = path.join(PARENT, 'clavis-viewer-web');
const EDITOR = path.join(PARENT, 'Clavis-editor');
const ROUTING_VIEWER = path.join(ROUTING, 'viewer');

function ensureSibling(dir, name) {
  if (!fs.existsSync(dir)) {
    console.error(`\nMissing sibling: ${name} (expected at ${dir}).`);
    console.error(`Clone it next to clavis-routing and run "npm install" there.\n`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    console.error(`\n${name} has no node_modules. Run "npm install" in ${dir} first.\n`);
    process.exit(1);
  }
}

ensureSibling(VIEWER_WEB, 'clavis-viewer-web');
ensureSibling(EDITOR, 'Clavis-editor');

const ANSI = {
  reset: '\x1b[0m',
  colors: ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m']
};

const children = [];

function start(name, cmd, args, cwd, env = {}) {
  const color = ANSI.colors[children.length % ANSI.colors.length];
  console.log(`${color}[${name}]${ANSI.reset} starting in ${cwd}`);
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, ...env, FORCE_COLOR: '1' }
  });
  const prefix = (line) => `${color}[${name}]${ANSI.reset} ${line}`;
  child.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'));
  child.stderr.on('data', (d) => process.stderr.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'));
  child.on('exit', (code) => console.log(prefix(`exited with code ${code}`)));
  children.push(child);
  return child;
}

const distTargets = [
  path.join(ROUTING_VIEWER, 'node_modules', '@artsdatabanken', 'clavis-viewer-web'),
  path.join(EDITOR, 'node_modules', '@artsdatabanken', 'clavis-viewer-web')
];

function syncDist() {
  const src = path.join(VIEWER_WEB, 'dist');
  if (!fs.existsSync(src)) return;
  for (const targetRoot of distTargets) {
    if (!fs.existsSync(targetRoot)) continue;
    const targetDist = path.join(targetRoot, 'dist');
    fs.rmSync(targetDist, { recursive: true, force: true });
    fs.cpSync(src, targetDist, { recursive: true });
    try {
      fs.copyFileSync(path.join(VIEWER_WEB, 'package.json'), path.join(targetRoot, 'package.json'));
    } catch {}
  }
  console.log('\x1b[90m[sync]\x1b[0m viewer-web/dist → consumers');
}

let syncTimer = null;
function watchDist() {
  const dist = path.join(VIEWER_WEB, 'dist');
  if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });
  fs.watch(dist, { recursive: true }, () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncDist, 300);
  });
}

syncDist();
watchDist();

start('viewer-web', 'npm', ['start'], VIEWER_WEB);
start('routing-viewer', 'npm', ['start'], ROUTING_VIEWER, {
  PORT: '3000',
  BROWSER: 'none',
  WDS_SOCKET_PORT: '5000',
  WDS_SOCKET_PATH: '/viewer/ws'
});
start('editor', 'npm', ['start'], EDITOR, {
  PORT: '3001',
  BROWSER: 'none',
  WDS_SOCKET_PORT: '5000',
  WDS_SOCKET_PATH: '/editor/ws'
});
start('routing', 'node', ['server.js'], ROUTING, {
  NODE_ENV: 'development',
  DEV_VIEWER_URL: 'http://localhost:3000',
  DEV_EDITOR_URL: 'http://localhost:3001'
});

function shutdown() {
  console.log('\nShutting down...');
  for (const c of children) {
    try { c.kill('SIGINT'); } catch {}
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
