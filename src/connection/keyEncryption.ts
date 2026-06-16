import { utils as ssh2Utils } from 'ssh2';

/**
 * Decide whether a private key is passphrase-encrypted (i.e. a passphrase is
 * required to use it for SSH authentication).
 *
 * We delegate to ssh2's own `utils.parseKey` — the exact parser ssh2 uses when
 * establishing the connection — so our prompt decision is always consistent
 * with what the real connection will require. `parseKey` RETURNS (does not
 * throw) an `Error` for an encrypted key when no/invalid passphrase is given;
 * its message reads "Encrypted private OpenSSH key detected, but no passphrase
 * given". A successful parse (the result is not an `Error`) means the key is
 * usable as-is, i.e. unencrypted.
 *
 * This is more robust than the old `keyText.includes('ENCRYPTED')` heuristic,
 * which only matched legacy PEM headers (`Proc-Type: 4,ENCRYPTED`) and silently
 * missed encrypted keys in the modern OpenSSH format — there the cipher name
 * (e.g. `aes256-ctr`) lives inside the base64 body, not in a header line, so the
 * literal string "ENCRYPTED" never appears.
 *
 * If parsing fails for some OTHER reason (a genuinely malformed key), we return
 * `false`: we cannot honestly call it "encrypted", and the subsequent connection
 * attempt will surface the real parse error rather than a misleading passphrase
 * prompt.
 */
export function isPrivateKeyEncrypted(keyData: string | Buffer): boolean {
  const parsed = ssh2Utils.parseKey(keyData);
  if (parsed instanceof Error) {
    return /passphrase|encrypted/i.test(parsed.message);
  }
  return false;
}

/**
 * True if a connection error means the private key could not be decrypted with
 * the supplied passphrase — i.e. the passphrase was wrong, empty, or missing.
 *
 * ssh2 surfaces these as CLIENT-SIDE "Cannot parse privateKey: ..." errors,
 * which do NOT contain the usual server-auth keywords ("authentication",
 * "Permission denied", ...). A caller that only sniffs for those keywords would
 * mistake a wrong passphrase for a generic failure and skip the "re-enter
 * passphrase" recovery. The three real ssh2 messages this matches:
 *   - "...OpenSSH key integrity check failed -- bad passphrase?"      (wrong)
 *   - "...Failed to generate information to decrypt key"               (empty)
 *   - "...Encrypted private OpenSSH key detected, but no passphrase given" (missing)
 *
 * The signals are passphrase-specific on purpose: a genuinely malformed
 * (non-encrypted) key fails with a different "Cannot parse privateKey" detail
 * that does NOT match, so it is not misreported as a passphrase problem.
 */
export function isKeyPassphraseError(message: string): boolean {
  return /bad passphrase|integrity check|decrypt key|no passphrase given/i.test(message);
}
