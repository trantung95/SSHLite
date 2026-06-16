/**
 * keyEncryption.isPrivateKeyEncrypted — uses the REAL ssh2 parser (no mock) so
 * the detection matches what the live connection will require.
 *
 * Fixtures are throwaway keys generated with ssh-keygen (passphrase, where
 * applicable, is "testphrase"). The encrypted Ed25519 key is in the modern
 * OpenSSH format whose body cipher is `aes256-ctr` — crucially it does NOT
 * contain the literal string "ENCRYPTED", which is exactly the case the old
 * `keyText.includes('ENCRYPTED')` heuristic missed.
 */

import { isPrivateKeyEncrypted, isKeyPassphraseError } from './keyEncryption';

// Unencrypted Ed25519 (cipher "none").
const PLAIN_ED25519 = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCWt8xDlgnuhN97jVGwVv165EPxdH71F1wk1A8cWrb5vgAAAKDBgRoowYEa
KAAAAAtzc2gtZWQyNTUxOQAAACCWt8xDlgnuhN97jVGwVv165EPxdH71F1wk1A8cWrb5vg
AAAECyKSQH0Ax8ZMzBpjSC3Cm/zbQ4qas3Msh5AwErUupx+5a3zEOWCe6E33uNUbBW/Xrk
Q/F0fvUXXCTUDxxatvm+AAAAFnR1bmcudHJhbkBDVC1WTi1ERVYtMDYBAgMEBQYH
-----END OPENSSH PRIVATE KEY-----`;

// Encrypted Ed25519 (modern OpenSSH format, cipher aes256-ctr, kdf bcrypt).
// Note: no literal "ENCRYPTED" anywhere in the text. Passphrase: "testphrase".
const ENC_ED25519 = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAm4IXp2f
lSmYUho8JbV2CeAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAINkcOyIU6tKhOwF3
irLEZsJG11zwotxS5bbmmCWgsvGnAAAAoJi6UXvLQVL0fpU6pshUulYntOiex5In5uf1Jv
Qw50XyVPHrKPPEC9Jft3lm2TzOx7XAdAn+407WCQf1vqv89VgyzQELDTZDzFSy+QWBKXcL
iLDKYtI0pgXhuF6mUb3ENq8vMAjFIPJ3OjNULp9elQ3k1+sJl1tcksaweYpSpgPYrfbIkk
qqrk/zt1MOgX/zxVXSRt3R043eS8D7LXhGJ84=
-----END OPENSSH PRIVATE KEY-----`;

describe('isPrivateKeyEncrypted', () => {
  it('returns false for an unencrypted OpenSSH key', () => {
    expect(isPrivateKeyEncrypted(PLAIN_ED25519)).toBe(false);
  });

  it('returns true for a modern-OpenSSH encrypted key with NO "ENCRYPTED" marker (old heuristic missed this)', () => {
    // Sanity: confirm the substring heuristic would have been wrong here.
    expect(ENC_ED25519.includes('ENCRYPTED')).toBe(false);
    expect(isPrivateKeyEncrypted(ENC_ED25519)).toBe(true);
  });

  it('accepts a Buffer as well as a string', () => {
    expect(isPrivateKeyEncrypted(Buffer.from(PLAIN_ED25519))).toBe(false);
    expect(isPrivateKeyEncrypted(Buffer.from(ENC_ED25519))).toBe(true);
  });

  it('returns false for a genuinely malformed key (cannot claim it is encrypted)', () => {
    expect(isPrivateKeyEncrypted('not a key at all')).toBe(false);
    expect(isPrivateKeyEncrypted('-----BEGIN OPENSSH PRIVATE KEY-----\ngarbage\n-----END OPENSSH PRIVATE KEY-----')).toBe(false);
  });
});

describe('isKeyPassphraseError', () => {
  // The three exact strings ssh2 throws (captured live against the encrypted
  // docker test key) — wrong, empty, and missing passphrase respectively.
  it('matches the wrong-passphrase error', () => {
    expect(isKeyPassphraseError('Cannot parse privateKey: OpenSSH key integrity check failed -- bad passphrase?')).toBe(true);
  });

  it('matches the empty-passphrase-on-encrypted-key error', () => {
    expect(isKeyPassphraseError('Cannot parse privateKey: Failed to generate information to decrypt key')).toBe(true);
  });

  it('matches the missing-passphrase error', () => {
    expect(isKeyPassphraseError('Cannot parse privateKey: Encrypted private OpenSSH key detected, but no passphrase given')).toBe(true);
  });

  it('does NOT match a server-side auth rejection or unrelated errors', () => {
    expect(isKeyPassphraseError('All configured authentication methods failed')).toBe(false);
    expect(isKeyPassphraseError('Permission denied (publickey)')).toBe(false);
    expect(isKeyPassphraseError('connect ECONNREFUSED 127.0.0.1:22')).toBe(false);
    // A malformed (non-encrypted) key parse failure must not be mislabeled.
    expect(isKeyPassphraseError('Cannot parse privateKey: Malformed OpenSSH private key')).toBe(false);
  });
});
