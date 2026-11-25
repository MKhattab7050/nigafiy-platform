// Where each endpoint's live stream is connected, as this process knows it: its own agent sockets
// and the "up"/"down" announcements of the other API instances (stream-hub.ts). Read by the
// session status route; the stream hub keeps it current.

interface Entry {
  sessionId: string;
  instance: string;
  peerUrl: string;
  at: number;
}

const connected = new Map<string, Map<string, Entry>>();

export function markStreamUp(endpointId: string, sessionId: string, instance: string, peerUrl: string): void {
  let m = connected.get(endpointId);
  if (!m) {
    m = new Map();
    connected.set(endpointId, m);
  }
  // One agent socket per endpoint: a newer announcement replaces the others.
  m.clear();
  m.set(instance, { sessionId, instance, peerUrl, at: Date.now() });
}

export function markStreamDown(endpointId: string, instance: string): void {
  const m = connected.get(endpointId);
  if (!m) return;
  m.delete(instance);
  if (m.size === 0) connected.delete(endpointId);
}

/** Forgets the endpoint's stream; with `sessionId`, only entries of that session. */
export function clearStream(endpointId: string, sessionId: string | null = null): void {
  const m = connected.get(endpointId);
  if (!m) return;
  if (sessionId !== null) {
    for (const [instance, e] of m) if (e.sessionId === sessionId) m.delete(instance);
    if (m.size > 0) return;
  }
  connected.delete(endpointId);
}

/** The instance holding the endpoint's agent socket for this session, if known. */
export function streamLocation(endpointId: string, sessionId: string): Entry | null {
  for (const e of connected.get(endpointId)?.values() ?? []) if (e.sessionId === sessionId) return e;
  return null;
}

export function isStreamConnected(endpointId: string, sessionId: string): boolean {
  return streamLocation(endpointId, sessionId) !== null;
}
