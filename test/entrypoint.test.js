const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const pkg = require('../package.json');

// This file covers the process entry point only: src/index.js binding process.env.PORT
// (default 3000) and logging it, plus the manifest's start script as a known defect.

const serviceDir = path.join(__dirname, '..');
const HEALTH_TIMEOUT_MS = 10000;
const MANIFEST_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Binds port 0 without a host argument, so the probe uses the same binding the app performs.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function portHeld(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(true);
        return;
      }
      reject(error);
    });
    probe.listen(port, () => {
      probe.close(() => resolve(false));
    });
  });
}

// Bounded poll on GET /health. A failure reports what the child printed, which is the only
// diagnostic available when a spawned process dies before it binds.
async function waitForHealth(baseUrl, timeoutMs, readOutput) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        const body = await response.json();
        if (body && body.status === 'ok') return body;
        lastError = new Error(`unexpected health body ${JSON.stringify(body)}`);
      } else {
        lastError = new Error(`health responded with status ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await pause(POLL_INTERVAL_MS);
  }
  const reason = lastError ? `: ${lastError.message}` : '';
  throw new Error(
    `service did not answer GET ${baseUrl}/health within ${timeoutMs}ms${reason}; child output: ${readOutput()}`,
  );
}

// Captures both streams for diagnostics; a spawn failure is recorded there instead of
// surfacing as an unhandled 'error' event.
function startService(command, args, env, shell = false) {
  const child = spawn(command, args, { cwd: serviceDir, env, shell });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', (error) => {
    stderr += `${error.message}\n`;
  });
  return {
    child,
    readStdout: () => stdout,
    readOutput: () => `${stdout}${stderr}${childStatus(child)}`,
  };
}

// A spawned process that exits silently is the common failure here, so the poll diagnostic
// says what became of the child as well as what it printed.
function childStatus(child) {
  if (child.exitCode !== null) return `child exited with code ${child.exitCode}`;
  if (child.signalCode !== null) return `child exited on signal ${child.signalCode}`;
  return 'child still running';
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

test('entry point serves the app on the port named by PORT and logs it', async () => {
  const port = await freePort();
  const { child, readStdout, readOutput } = startService(
    process.execPath,
    ['src/index.js'],
    { ...process.env, PORT: String(port) },
  );
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, HEALTH_TIMEOUT_MS, readOutput);
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.match(readStdout(), new RegExp(`warehouse API listening on ${port}`));
  } finally {
    await stopChild(child);
  }
});

test('entry point falls back to port 3000 when PORT is unset', async (t) => {
  if (await portHeld(3000)) {
    t.skip('port 3000 is occupied in this environment');
    return;
  }
  const env = { ...process.env };
  delete env.PORT;
  const { child, readStdout, readOutput } = startService(process.execPath, ['src/index.js'], env);
  try {
    const baseUrl = 'http://127.0.0.1:3000';
    await waitForHealth(baseUrl, HEALTH_TIMEOUT_MS, readOutput);
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.match(readStdout(), /warehouse API listening on 3000/);
  } finally {
    await stopChild(child);
  }
});

// Expected failure: recorded, never repaired, because production behaviour is frozen.
test('manifest start script serves the app', {
  todo: 'package.json:5 sets start to `node src/server.js`, and src/server.js:53 is `module.exports = app` with no listen call, so `npm start` starts a process that serves nothing',
}, async () => {
  const port = await freePort();
  const { child, readOutput } = startService(
    pkg.scripts.start,
    [],
    { ...process.env, PORT: String(port) },
    true,
  );
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, MANIFEST_TIMEOUT_MS, readOutput);
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
  } finally {
    await stopChild(child);
  }
});
