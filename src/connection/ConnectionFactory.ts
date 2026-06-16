import { IConnection, IHostConfig, getConnectionType, ConnectionError } from '../types';
import { SavedCredential } from '../services/CredentialService';
import { SSHConnection } from './SSHConnection';
import { FTPConnection } from './FTPConnection';
import { infoLog } from '../utils/diagnosticLog';
import { isEndpointHost } from '../utils/hostId';

/**
 * Create the right connection implementation for a host based on its
 * transport protocol. Absence of `connectionType` ⇒ SSH (backward compat).
 *
 * This is the single place that decides SSHConnection vs FTPConnection;
 * ConnectionManager calls it instead of `new SSHConnection(...)` directly.
 * It is therefore the single chokepoint where an endpoint record (a server
 * with no account yet) is rejected — so no transport (SSH or FTP) can ever be
 * opened with an empty username (e.g. an accidental anonymous FTP login).
 */
export function createConnection(host: IHostConfig, credential?: SavedCredential): IConnection {
  if (isEndpointHost(host)) {
    throw new ConnectionError(
      'This is a server endpoint with no account yet. Use "Add User..." to add an account before connecting.'
    );
  }
  const type = getConnectionType(host);
  infoLog('connection-factory', 'create', {
    type,
    host: host.host,
    port: host.port,
    hasCredential: !!credential,
  });
  return type === 'ftp' ? new FTPConnection(host, credential) : new SSHConnection(host, credential);
}
