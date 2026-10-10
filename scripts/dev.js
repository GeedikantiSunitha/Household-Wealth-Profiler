#!/usr/bin/env node
// npm run dev: local demo on any OS (Windows cmd.exe cannot read VAR=value prefixes).
// Sign in as demo / demo; data is kept unencrypted in ./data-dev. These settings win over .env,
// so a .env with DATABASE_URL or DATA_KEY is left alone: use npm start for that set-up.
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const server = path.join(root, 'server.js');
const demo = execFileSync(process.execPath, [server, 'hash-password', 'demo', 'demo']).toString().trim();
const env = { ...process.env, ALLOW_PLAINTEXT: '1', HSTS: '0', AUTH_USERS: demo, DATA_DIR: path.join(root, 'data-dev'), DATABASE_URL: '', DATA_KEY: '' };
const child = spawn(process.execPath, [server], { cwd: root, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
