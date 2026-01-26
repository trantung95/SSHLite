import * as os from 'os';
import {
  normalizeLocalPath,
  expandPath,
  validatePort,
  formatFileSize,
  formatRelativeTime,
  formatDateTime,
} from './helpers';

describe('helpers', () => {
  describe('normalizeLocalPath', () => {
    describe('Windows drive letter normalization', () => {
      it('should lowercase uppercase drive letter', () => {
        expect(normalizeLocalPath('C:\\Users\\test\\file.ts')).toBe('c:\\Users\\test\\file.ts');
      });

      it('should keep already-lowercase drive letter unchanged', () => {
        expect(normalizeLocalPath('c:\\Users\\test\\file.ts')).toBe('c:\\Users\\test\\file.ts');
      });

      it('should handle various drive letters (D:, E:, etc.)', () => {
        expect(normalizeLocalPath('D:\\Data\\file.ts')).toBe('d:\\Data\\file.ts');
        expect(normalizeLocalPath('E:\\Projects\\ssh-lite')).toBe('e:\\Projects\\ssh-lite');
        expect(normalizeLocalPath('Z:\\Network\\share')).toBe('z:\\Network\\share');
      });

      it('should only lowercase the drive letter, not the rest of the path', () => {
        expect(normalizeLocalPath('C:\\Users\\John\\Documents\\MyFile.TS'))
          .toBe('c:\\Users\\John\\Documents\\MyFile.TS');
      });

      it('should handle drive letter with forward slashes', () => {
        // Some APIs return forward slashes on Windows
        expect(normalizeLocalPath('C:/Users/test/file.ts')).toBe('c:/Users/test/file.ts');
      });

      it('should handle drive letter only (root)', () => {
        expect(normalizeLocalPath('C:\\')).toBe('c:\\');
        expect(normalizeLocalPath('D:\\')).toBe('d:\\');
      });
    });

    describe('Unix paths (no normalization needed)', () => {
      it('should return Unix paths unchanged', () => {
        expect(normalizeLocalPath('/home/user/file.ts')).toBe('/home/user/file.ts');
      });

      it('should return macOS temp dir unchanged', () => {
        expect(normalizeLocalPath('/var/folders/zz/abc123/T/ssh-lite'))
          .toBe('/var/folders/zz/abc123/T/ssh-lite');
      });

      it('should return Linux temp dir unchanged', () => {
        expect(normalizeLocalPath('/tmp/ssh-lite/conn1/file.ts'))
          .toBe('/tmp/ssh-lite/conn1/file.ts');
      });

      it('should handle root path', () => {
        expect(normalizeLocalPath('/')).toBe('/');
      });
    });

    describe('edge cases', () => {
      it('should handle empty string', () => {
        expect(normalizeLocalPath('')).toBe('');
      });

      it('should handle single character', () => {
        expect(normalizeLocalPath('a')).toBe('a');
      });

      it('should not modify paths with colon in non-drive position', () => {
        // Unix paths can technically have colons (unlikely but possible)
        expect(normalizeLocalPath('/home/user/file:backup.ts'))
          .toBe('/home/user/file:backup.ts');
      });

      it('should handle UNC paths (no drive letter)', () => {
        // UNC paths like \\server\share don't have drive letters
        expect(normalizeLocalPath('\\\\server\\share\\file.ts'))
          .toBe('\\\\server\\share\\file.ts');
      });
    });

    describe('real-world Windows path case mismatch scenario', () => {
      it('should make os.tmpdir and VS Code fsPath match', () => {
        // Simulate: os.tmpdir() returns "C:\\Users\\user\\AppData\\Local\\Temp"
        // VS Code's document.uri.fsPath returns "c:\\Users\\user\\AppData\\Local\\Temp"
        const osTmpDir = 'C:\\Users\\user\\AppData\\Local\\Temp';
        const vscodeFsPath = 'c:\\Users\\user\\AppData\\Local\\Temp';

        const normalizedTmpDir = normalizeLocalPath(osTmpDir);
        const normalizedFsPath = normalizeLocalPath(vscodeFsPath);

        expect(normalizedTmpDir).toBe(normalizedFsPath);
      });

      it('should make path.join(tmpdir, ...) and fsPath match', () => {
        const osTmpDir = 'C:\\Users\\user\\AppData\\Local\\Temp';
        const joined = osTmpDir + '\\ssh-lite\\conn1\\file.ts';
        const fsPath = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts';

        expect(normalizeLocalPath(joined)).toBe(normalizeLocalPath(fsPath));
      });

      it('should ensure startsWith works after normalization', () => {
        const tempDir = normalizeLocalPath('C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite');
        const filePath = normalizeLocalPath('c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts');

        expect(filePath.startsWith(tempDir)).toBe(true);
      });

      it('should ensure Map lookup works after normalization', () => {
        const map = new Map<string, string>();
        const internalPath = normalizeLocalPath('C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts');
        map.set(internalPath, 'remote:/path/file.ts');

        const externalPath = normalizeLocalPath('c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts');
        expect(map.get(externalPath)).toBe('remote:/path/file.ts');
      });
    });
  });

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
