/**
 * ConnectionFactory endpoint guard (Phase 2 of connect-time-accounts).
 *
 * createConnection is the single chokepoint that decides SSH vs FTP. An endpoint
 * record (isEndpoint:true, no account yet) must be rejected here so NO transport
 * is ever opened with an empty username — covers critical B1 (accidental
 * anonymous FTP login). A normal account host still constructs a connection.
 */

import { createConnection } from './ConnectionFactory';
import { ConnectionError, IHostConfig } from '../types';

function host(partial: Partial<IHostConfig>): IHostConfig {
  return {
    id: 'x',
    name: 'X',
    host: 'srv.com',
    port: 22,
    username: 'alice',
    source: 'saved',
    ...partial,
  };
}

describe('createConnection endpoint guard', () => {
  it('throws for an SSH endpoint (no account yet)', () => {
    expect(() => createConnection(host({ username: '', isEndpoint: true })))
      .toThrow(ConnectionError);
  });

  it('throws for an FTP endpoint (no account yet)', () => {
    expect(() => createConnection(host({ username: '', isEndpoint: true, connectionType: 'ftp' })))
      .toThrow(ConnectionError);
  });

  it('does NOT throw for a normal account host (SSH)', () => {
    expect(() => createConnection(host({ username: 'alice' }))).not.toThrow();
  });

  it('does NOT throw for a normal account host (FTP)', () => {
    expect(() => createConnection(host({ username: 'alice', connectionType: 'ftp' }))).not.toThrow();
  });
});
