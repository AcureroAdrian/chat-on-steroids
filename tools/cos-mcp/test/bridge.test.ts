import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeHello } from '../src/bridge.js';
import { parsePorts } from '../src/env.js';

function serve(body: unknown): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url !== '/hello') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const portOf = (server: http.Server) => (server.address() as AddressInfo).port;

describe('probeHello', () => {
  let cos: http.Server;
  let other: http.Server;
  let closedPort: number;

  beforeAll(async () => {
    cos = await serve({ app: 'chat-on-steroids', version: '2.1.19', bridge: 14, compatible: null, paired: false, disconnected: false });
    other = await serve({ app: 'something-else' });
    const closed = await serve({});
    closedPort = portOf(closed);
    await new Promise((resolve) => closed.close(resolve));
  });

  afterAll(async () => {
    await Promise.all([cos, other].map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it('finds the app among other listeners and closed ports', async () => {
    const reply = await probeHello([closedPort, portOf(other), portOf(cos)]);
    expect(reply).toMatchObject({ port: portOf(cos), version: '2.1.19', bridgeProtocol: 14, paired: false });
  });

  it('answers null when nothing on the ports is the app', async () => {
    expect(await probeHello([closedPort, portOf(other)])).toBeNull();
  });
});

describe('parsePorts', () => {
  it('reads ranges and lists and drops junk', () => {
    expect(parsePorts('8765-8767')).toEqual([8765, 8766, 8767]);
    expect(parsePorts('8765, 9000')).toEqual([8765, 9000]);
    expect(parsePorts('0')).toBeNull();
    expect(parsePorts('')).toBeNull();
  });
});
