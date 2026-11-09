import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockAcs } from './mockAcs.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

test('closing stdin stops the app cleanly and saves state (how the Windows service stops it)', async () => {
  const acs = await startMockAcs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-roster-stop-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ acs: { baseUrl: acs.url }, server: { host: '127.0.0.1', port: 0 } }));
  const child = spawn(process.execPath, [ENTRY, 'run', '--config', config, '--stop-on-stdin-close'], {
    env: { ...process.env, ACS_USERNAME: 'u', ACS_PASSWORD: 'p' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('dashboard')) resolve(); });
      child.on('exit', (code) => reject(new Error(`exited early with code ${code}`)));
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.ok(fs.readdirSync(path.join(dir, 'data')).length > 0, 'state was saved');
  } finally {
    child.kill();
    await acs.close?.();
  }
});
