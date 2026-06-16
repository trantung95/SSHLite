import { buildHostId, parseHostId, isEndpointHost, defaultPort } from './hostId';

describe('hostId', () => {
  describe('buildHostId', () => {
    it('builds an account id', () => {
      expect(buildHostId({ host: 'h.com', port: 22, username: 'alice' })).toBe('h.com:22:alice');
    });
    it('builds an endpoint id with empty username, never the literal "undefined"', () => {
      expect(buildHostId({ host: 'h.com', port: 22 })).toBe('h.com:22:');
      expect(buildHostId({ host: 'h.com', port: 22, username: undefined })).toBe('h.com:22:');
      expect(buildHostId({ host: 'h.com', port: 22 })).not.toContain('undefined');
    });
    it('defaults port by protocol when absent', () => {
      expect(buildHostId({ host: 'h', username: 'a' })).toBe('h:22:a');
      expect(buildHostId({ host: 'h', username: 'a', connectionType: 'ftp' })).toBe('h:21:a');
    });
  });

  describe('parseHostId (right-anchored, IPv6-safe)', () => {
    it('parses an account id', () => {
      expect(parseHostId('h.com:22:alice')).toEqual({ host: 'h.com', port: 22, username: 'alice' });
    });
    it('parses an endpoint id (empty username)', () => {
      expect(parseHostId('h.com:22:')).toEqual({ host: 'h.com', port: 22, username: '' });
    });
    it('parses IPv6 hosts that contain colons', () => {
      expect(parseHostId('::1:22:alice')).toEqual({ host: '::1', port: 22, username: 'alice' });
      expect(parseHostId('::1:22:')).toEqual({ host: '::1', port: 22, username: '' });
      expect(parseHostId('2001:db8::1:2222:bob')).toEqual({ host: '2001:db8::1', port: 2222, username: 'bob' });
    });
  });

  describe('round-trip', () => {
    it.each(['h:22:alice', 'h:22:', '::1:22:alice', '::1:22:', '2001:db8::1:2222:bob'])(
      'build(parse(%s)) === %s',
      (id) => {
        expect(buildHostId(parseHostId(id))).toBe(id);
      }
    );
  });

  describe('isEndpointHost', () => {
    it('is true only for the explicit flag', () => {
      expect(isEndpointHost({ isEndpoint: true })).toBe(true);
      expect(isEndpointHost({ username: 'alice' })).toBe(false);
      expect(isEndpointHost({ username: '' })).toBe(false); // malformed, not an endpoint
    });
  });

  describe('defaultPort', () => {
    it('22 for ssh/undefined, 21 for ftp', () => {
      expect(defaultPort()).toBe(22);
      expect(defaultPort('ssh')).toBe(22);
      expect(defaultPort('ftp')).toBe(21);
    });
  });
});
