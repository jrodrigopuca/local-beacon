import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { testCLI } from '@runa-cmd/core/testing';

import { createControlServer } from '../core/control.ts';
import { createProxy } from '../core/proxy.ts';
import { cli } from './cli.ts';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function socketPath(): string {
  const directory = mkdtempSync('/tmp/lbeacon-cmd-');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'control.sock');
}

async function startControl(socket: string): Promise<void> {
  const proxy = createProxy({ upstream: 'http://127.0.0.1:1', port: 0 });
  const control = createControlServer({ proxy, upstream: 'http://127.0.0.1:1', socketPath: socket });
  await control.listen();
  cleanups.push(() => control.close());
}

describe('commands', () => {
  it('fails with exit 3 and the next step when the proxy is off', async () => {
    const env = { LBEACON_SOCKET: socketPath() };
    for (const argv of [['status'], ['requests'], ['cancel', 'abc']]) {
      const result = await testCLI(cli, argv, { env });
      assert.equal(result.code, 3, argv.join(' '));
      assert.match(result.stderr, /not running.*lbeacon proxy/);
      assert.equal(result.stdout, '');
    }
  });

  it('asks for an upstream, and rejects an invalid one', async () => {
    const socket = socketPath();
    assert.equal((await testCLI(cli, ['proxy', '--socket', socket], { env: { OLLAMA_URL: '' } })).code, 2);
    assert.equal((await testCLI(cli, ['proxy', '-u', 'not a url', '--socket', socket])).code, 2);
  });

  it('prints for people, and gives the same data to --json and to a tool', async () => {
    const socket = socketPath();
    await startControl(socket);
    const env = { LBEACON_SOCKET: socket };

    const text = await testCLI(cli, ['requests'], { env });
    assert.equal(text.code, 0);
    assert.match(text.stdout, /no requests yet/);
    assert.deepEqual(text.result, { requests: [] });

    const json = await testCLI(cli, ['requests', '--json'], { env });
    assert.deepEqual(JSON.parse(json.stdout), text.result);
  });

  it('a request that is not in flight exits with 4', async () => {
    const socket = socketPath();
    await startControl(socket);
    const result = await testCLI(cli, ['cancel', 'abc'], { env: { LBEACON_SOCKET: socket } });
    assert.equal(result.code, 4);
    assert.match(result.stderr, /not in flight/);
  });

  it('keeps concurrent runs apart', async () => {
    const socket = socketPath();
    await startControl(socket);
    const env = { LBEACON_SOCKET: socket };
    const [listed, missing] = await Promise.all([
      testCLI(cli, ['requests'], { env }),
      testCLI(cli, ['cancel', 'abc'], { env }),
    ]);
    assert.match(listed.stdout, /no requests yet/);
    assert.equal(listed.stderr, '');
    assert.equal(missing.stdout, '');
  });
});
