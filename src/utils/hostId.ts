import type { ConnectionType } from '../types';

/** Minimal shape needed to build a host id. */
export interface HostIdParts {
  host: string;
  port?: number;
  username?: string;
  connectionType?: ConnectionType;
}

/** Default port by protocol (ssh 22, ftp 21). */
export function defaultPort(connectionType?: ConnectionType): number {
  return connectionType === 'ftp' ? 21 : 22;
}

/**
 * Canonical connection/host id: `${host}:${port}:${username}`.
 *
 * Username is normalised to '' (never the literal string "undefined"), so an
 * endpoint record (no username) yields `host:port:` rather than
 * `host:port:undefined`. This is the ONLY place ids should be constructed —
 * see `parseHostId` for the matching right-anchored parse.
 */
export function buildHostId(h: HostIdParts): string {
  const port = h.port ?? defaultPort(h.connectionType);
  const username = h.username ?? '';
  return `${h.host}:${port}:${username}`;
}

export interface ParsedHostId {
  host: string;
  port: number;
  username: string;
}

/**
 * Parse a host id built by `buildHostId`. Splits from the RIGHT so the username
 * (last segment, may be empty) and port (second-from-last) are unambiguous even
 * when the host itself contains ':' (IPv6, e.g. '::1:22:alice' or '::1:22:').
 *
 * Returns `port: NaN` for a malformed id that lacks two colons.
 */
export function parseHostId(id: string): ParsedHostId {
  const lastColon = id.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: id, port: NaN, username: '' };
  }
  const username = id.slice(lastColon + 1);
  const secondColon = id.lastIndexOf(':', lastColon - 1);
  if (secondColon === -1) {
    return { host: id.slice(0, lastColon), port: NaN, username };
  }
  return {
    host: id.slice(0, secondColon),
    port: parseInt(id.slice(secondColon + 1, lastColon), 10),
    username,
  };
}

/** True when a host config represents an endpoint (a server with no account yet). */
export function isEndpointHost(h: { isEndpoint?: boolean; username?: string }): boolean {
  return h.isEndpoint === true;
}
