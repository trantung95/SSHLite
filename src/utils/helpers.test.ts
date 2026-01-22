import * as os from 'os';
import {
  expandPath,
  validatePort,
  formatFileSize,
  formatRelativeTime,
  formatDateTime,
} from './helpers';

describe('helpers', () => {
  describe('expandPath', () => {
    it('should expand ~ to home directory', () => {
      const result = expandPath('~/.ssh/id_rsa');
      expect(result).toBe(`${os.homedir()}/.ssh/id_rsa`);
    });

    it('should expand ~ alone to home directory', () => {
      const result = expandPath('~');
      expect(result).toBe(os.homedir());
    });

    it('should not modify paths without ~', () => {
      const result = expandPath('/home/user/.ssh/id_rsa');
      expect(result).toBe('/home/user/.ssh/id_rsa');
    });

    it('should not expand ~ in middle of path', () => {
      const result = expandPath('/home/user/~test');
      expect(result).toBe('/home/user/~test');
    });

    it('should handle empty string', () => {
      const result = expandPath('');
      expect(result).toBe('');
    });
  });

  describe('validatePort', () => {
    it('should return null for valid port numbers', () => {
      expect(validatePort('22')).toBeNull();
      expect(validatePort('80')).toBeNull();
      expect(validatePort('443')).toBeNull();
      expect(validatePort('8080')).toBeNull();
      expect(validatePort('1')).toBeNull();
      expect(validatePort('65535')).toBeNull();
    });

    it('should return error for port 0', () => {
      expect(validatePort('0')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should return error for negative ports', () => {
      expect(validatePort('-1')).toBe('Please enter a valid port number (1-65535)');
      expect(validatePort('-22')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should return error for ports above 65535', () => {
      expect(validatePort('65536')).toBe('Please enter a valid port number (1-65535)');
      expect(validatePort('100000')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should return error for non-numeric strings', () => {
      expect(validatePort('abc')).toBe('Please enter a valid port number (1-65535)');
      expect(validatePort('')).toBe('Please enter a valid port number (1-65535)');
      expect(validatePort('22.5')).toBeNull(); // parseInt parses this as 22
    });

    it('should handle whitespace in port strings', () => {
      expect(validatePort(' 22 ')).toBeNull(); // parseInt handles leading whitespace
    });
  });

  describe('formatFileSize', () => {
    it('should format 0 bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });

    it('should format bytes correctly', () => {
      expect(formatFileSize(100)).toBe('100 B');
      expect(formatFileSize(512)).toBe('512 B');
      expect(formatFileSize(1023)).toBe('1023 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
      expect(formatFileSize(10240)).toBe('10 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1 MB');
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
      expect(formatFileSize(100 * 1024 * 1024)).toBe('100 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });

    it('should format terabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
    });
  });

  describe('formatRelativeTime', () => {
    const NOW = Date.now();

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return "just now" for timestamps in the future', () => {
      expect(formatRelativeTime(NOW + 10000)).toBe('just now');
    });

    it('should return "just now" for timestamps less than 60 seconds ago', () => {
      expect(formatRelativeTime(NOW)).toBe('just now');
      expect(formatRelativeTime(NOW - 30 * 1000)).toBe('just now');
      expect(formatRelativeTime(NOW - 59 * 1000)).toBe('just now');
    });

    it('should format minutes correctly', () => {
      expect(formatRelativeTime(NOW - 60 * 1000)).toBe('1m ago');
      expect(formatRelativeTime(NOW - 5 * 60 * 1000)).toBe('5m ago');
      expect(formatRelativeTime(NOW - 59 * 60 * 1000)).toBe('59m ago');
    });

    it('should format hours correctly', () => {
      expect(formatRelativeTime(NOW - 60 * 60 * 1000)).toBe('1h ago');
      expect(formatRelativeTime(NOW - 12 * 60 * 60 * 1000)).toBe('12h ago');
      expect(formatRelativeTime(NOW - 23 * 60 * 60 * 1000)).toBe('23h ago');
    });

    it('should format days correctly', () => {
      expect(formatRelativeTime(NOW - 24 * 60 * 60 * 1000)).toBe('1d ago');
      expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60 * 1000)).toBe('3d ago');
      expect(formatRelativeTime(NOW - 6 * 24 * 60 * 60 * 1000)).toBe('6d ago');
    });

    it('should format weeks correctly', () => {
      expect(formatRelativeTime(NOW - 7 * 24 * 60 * 60 * 1000)).toBe('1w ago');
      expect(formatRelativeTime(NOW - 14 * 24 * 60 * 60 * 1000)).toBe('2w ago');
      expect(formatRelativeTime(NOW - 28 * 24 * 60 * 60 * 1000)).toBe('4w ago');
    });

    it('should format months correctly', () => {
      expect(formatRelativeTime(NOW - 35 * 24 * 60 * 60 * 1000)).toBe('1mo ago');
      expect(formatRelativeTime(NOW - 90 * 24 * 60 * 60 * 1000)).toBe('3mo ago');
      expect(formatRelativeTime(NOW - 300 * 24 * 60 * 60 * 1000)).toBe('10mo ago');
    });

    it('should format years correctly', () => {
      expect(formatRelativeTime(NOW - 365 * 24 * 60 * 60 * 1000)).toBe('1y ago');
      expect(formatRelativeTime(NOW - 2 * 365 * 24 * 60 * 60 * 1000)).toBe('2y ago');
    });
  });

  describe('formatDateTime', () => {
    it('should format a timestamp as locale string', () => {
      const timestamp = new Date('2024-01-15T10:30:00').getTime();
      const result = formatDateTime(timestamp);
      // Result depends on locale, so just verify it's a non-empty string
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle zero timestamp (epoch)', () => {
      const result = formatDateTime(0);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
