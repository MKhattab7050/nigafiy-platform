/**
 * Agents report connections either as separate address/port fields or as combined "addr:port"
 * strings (older agents); both are stored in the separate-field form.
 */
export function normalizeConnections(
  conns?: Array<{
    proto: string;
    local_address?: string;
    local_addr?: string;
    local_port?: number;
    remote_address?: string;
    remote_addr?: string;
    remote_port?: number;
    state: string;
    pid?: number;
    process_name?: string;
  }>,
) {
  if (!conns) return null;
  return conns.map((c) => {
    let localAddr = c.local_address ?? '';
    let localPort = c.local_port ?? 0;
    if (!localAddr && c.local_addr) {
      const idx = c.local_addr.lastIndexOf(':');
      if (idx > 0) {
        localAddr = c.local_addr.slice(0, idx);
        localPort = Number.parseInt(c.local_addr.slice(idx + 1), 10) || 0;
      } else {
        localAddr = c.local_addr;
      }
    }
    let remoteAddr = c.remote_address;
    let remotePort = c.remote_port;
    if (!remoteAddr && c.remote_addr) {
      const idx = c.remote_addr.lastIndexOf(':');
      if (idx > 0) {
        remoteAddr = c.remote_addr.slice(0, idx);
        remotePort = Number.parseInt(c.remote_addr.slice(idx + 1), 10) || 0;
      } else {
        remoteAddr = c.remote_addr;
      }
    }
    return {
      proto: c.proto.toLowerCase() === 'udp' ? 'udp' : 'tcp',
      local_address: localAddr || '0.0.0.0',
      local_port: localPort,
      ...(remoteAddr ? { remote_address: remoteAddr } : {}),
      ...(typeof remotePort === 'number' ? { remote_port: remotePort } : {}),
      state: c.state,
      ...(typeof c.pid === 'number' ? { pid: c.pid } : {}),
      ...(c.process_name ? { process_name: c.process_name } : {}),
    };
  });
}
