// Preloaded with `node --import` (M7 Task 2, Review Focus 4): any attempt to open a connection throws, so a run that
// still succeeds made none. Covers net, tls, dns, http(s), http2, dgram, fetch, WebSocket, worker threads and child
// processes (which could shell out). The built-in modules are patched in place and then `syncBuiltinESMExports()` is
// called, so `import { connect } from 'node:net'` sees the refusal as well as `import net from 'node:net'` and require().
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';

// a plain function, not an arrow: `new Worker(...)` must reach the refusal too
const refuse = (what) =>
  function () {
    throw new Error(`NETWORK ATTEMPT BLOCKED: ${what}`);
  };
for (const [name, mod, keys] of [
  ['net', net, ['connect', 'createConnection']],
  ['tls', tls, ['connect']],
  ['http', http, ['request', 'get']],
  ['https', https, ['request', 'get']],
  ['http2', http2, ['connect']],
  ['dgram', dgram, ['createSocket']],
  ['dns', dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ['child_process', childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['worker_threads', workerThreads, ['Worker']],
]) {
  for (const key of keys) mod[key] = refuse(`${name}.${key}`);
}
net.Socket.prototype.connect = refuse('net.Socket.connect');
dgram.Socket.prototype.send = refuse('dgram.Socket.send');
globalThis.fetch = refuse('fetch');
globalThis.WebSocket = refuse('WebSocket');
syncBuiltinESMExports();
