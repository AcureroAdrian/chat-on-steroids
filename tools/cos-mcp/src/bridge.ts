/**
 * Liveness through the app's browser bridge.
 *
 * `/hello` is the bridge's one unauthenticated identification route (bridge.ts documents it for
 * "curl in a bug report"). The bridge runs inside the app's main process, so an answer proves the
 * main event loop is serving requests; it proves nothing about the tunnel, the extension or chats.
 * No Origin header is sent, which the bridge treats as a local non-browser caller.
 */
export interface HelloReply {
  port: number;
  version: string | null;
  bridgeProtocol: number | null;
  paired: boolean | null;
  latencyMs: number;
}

async function helloOn(port: number, timeoutMs: number): Promise<HelloReply | null> {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hello`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (body.app !== 'chat-on-steroids') return null;
    return {
      port,
      version: typeof body.version === 'string' ? body.version : null,
      bridgeProtocol: typeof body.bridge === 'number' ? body.bridge : null,
      paired: typeof body.paired === 'boolean' ? body.paired : null,
      latencyMs: Date.now() - started
    };
  } catch {
    return null;
  }
}

/** One round over every candidate port; the first app that answers wins. */
export async function probeHello(ports: number[], timeoutMs = 2_500): Promise<HelloReply | null> {
  const replies = await Promise.all(ports.map((port) => helloOn(port, timeoutMs)));
  return replies.find((reply): reply is HelloReply => reply !== null) ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A few rounds spread over a few seconds, so a single slow tick is not reported as a hang. */
export async function probeResponsive(ports: number[], attempts = 3, gapMs = 2_000): Promise<HelloReply | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reply = await probeHello(ports);
    if (reply) return reply;
    if (attempt < attempts - 1) await sleep(gapMs);
  }
  return null;
}
