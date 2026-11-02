// Builds the Go sync server (server/) and starts it on a loopback port with a
// temporary database. Used by the sync tests and the browser smoke test.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const hasGo = spawnSync('go', ['version']).status === 0;
export const TEST_PASSWORD = 'sync-test-password';
const serverDir = fileURLToPath(new URL('../server', import.meta.url));

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * Starts a server with these accounts (all with TEST_PASSWORD).
 * Returns { url, stop }.
 */
export async function startGoServer({ users = ['alice'], admins = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tab-stash-server-'));
  const bin = join(dir, 'tab-stash-server');
  execFileSync('go', ['build', '-o', bin, './cmd/tab-stash-server'], { cwd: serverDir, stdio: 'inherit' });
  const salt = execFileSync(bin, ['gen-salt']).toString().trim();
  const env = { ...process.env, TAB_STASH_PASSWORD_SALT: salt, TAB_STASH_DB: join(dir, 'test.db') };
  const add = (name, ...flags) => execFileSync(bin, ['user', 'add', ...flags, name], { env, input: `${TEST_PASSWORD}\n` });
  for (const name of users) add(name);
  for (const name of admins) add(name, '-admin');

  const port = await freePort();
  const proc = spawn(bin, ['serve', '-addr', `127.0.0.1:${port}`], { env, stdio: 'ignore' });
  const stop = () => {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { url, stop };
    } catch { /* not started yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error('the server did not start');
}
