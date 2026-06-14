import { IConnection, IHostConfig, getConnectionType } from '../types';
import { SavedCredential } from '../services/CredentialService';
import { SSHConnection } from './SSHConnection';
import { FTPConnection } from './FTPConnection';
import { infoLog } from '../utils/diagnosticLog';

/**
 * Create the right connection implementation for a host based on its
 * transport protocol. Absence of `connectionType` ⇒ SSH (backward compat).
 *
 * This is the single place that decides SSHConnection vs FTPConnection;
 * ConnectionManager calls it instead of `new SSHConnection(...)` directly.
 */
export function createConnection(host: IHostConfig, credential?: SavedCredential): IConnection {
  const type = getConnectionType(host);
  infoLog('connection-factory', 'create', {
    type,
    host: host.host,
    port: host.port,
    hasCredential: !!credential,
  });
  return type === 'ftp' ? new FTPConnection(host, credential) : new SSHConnection(host, credential);
}
