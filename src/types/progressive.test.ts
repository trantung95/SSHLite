/**
 * Progressive types utility tests
 *
 * Tests the pure utility functions in progressive.ts:
 * - isLikelyBinary: file extension detection
 * - parsePreviewUri: URI parsing and validation
 * - createPreviewUri: URI construction
 * - loadProgressiveConfig: configuration loading
 * - DEFAULT_PROGRESSIVE_CONFIG: default values
 */

import { Uri, workspace } from '../__mocks__/vscode';
import {
  isLikelyBinary,
  parsePreviewUri,
  createPreviewUri,
  loadProgressiveConfig,
  DEFAULT_PROGRESSIVE_CONFIG,
  PROGRESSIVE_PREVIEW_SCHEME,
  BINARY_EXTENSIONS,
} from './progressive';

describe('progressive types', () => {
  describe('isLikelyBinary', () => {
    describe('should detect binary files', () => {
      it('should detect executables', () => {
        expect(isLikelyBinary('program.exe')).toBe(true);
        expect(isLikelyBinary('library.dll')).toBe(true);
        expect(isLikelyBinary('module.so')).toBe(true);
        expect(isLikelyBinary('framework.dylib')).toBe(true);
      });

      it('should detect archives', () => {
        expect(isLikelyBinary('archive.zip')).toBe(true);
        expect(isLikelyBinary('backup.tar')).toBe(true);
        expect(isLikelyBinary('compressed.gz')).toBe(true);
        expect(isLikelyBinary('data.bz2')).toBe(true);
        expect(isLikelyBinary('package.7z')).toBe(true);
      });

      it('should detect images', () => {
        expect(isLikelyBinary('photo.jpg')).toBe(true);
        expect(isLikelyBinary('image.jpeg')).toBe(true);
        expect(isLikelyBinary('icon.png')).toBe(true);
        expect(isLikelyBinary('animation.gif')).toBe(true);
        expect(isLikelyBinary('picture.webp')).toBe(true);
      });

      it('should detect documents', () => {
        expect(isLikelyBinary('report.pdf')).toBe(true);
        expect(isLikelyBinary('letter.doc')).toBe(true);
        expect(isLikelyBinary('sheet.xlsx')).toBe(true);
        expect(isLikelyBinary('slides.pptx')).toBe(true);
      });

      it('should detect media files', () => {
        expect(isLikelyBinary('song.mp3')).toBe(true);
        expect(isLikelyBinary('video.mp4')).toBe(true);
        expect(isLikelyBinary('movie.avi')).toBe(true);
        expect(isLikelyBinary('audio.wav')).toBe(true);
      });

      it('should detect databases', () => {
        expect(isLikelyBinary('data.sqlite')).toBe(true);
        expect(isLikelyBinary('app.db')).toBe(true);
      });

      it('should detect compiled files', () => {
        expect(isLikelyBinary('Main.class')).toBe(true);
        expect(isLikelyBinary('module.pyc')).toBe(true);
        expect(isLikelyBinary('output.o')).toBe(true);
        expect(isLikelyBinary('code.obj')).toBe(true);
      });
    });

    describe('should NOT detect text files as binary', () => {
      it('should pass through source code files', () => {
        expect(isLikelyBinary('app.ts')).toBe(false);
        expect(isLikelyBinary('index.js')).toBe(false);
        expect(isLikelyBinary('main.py')).toBe(false);
        expect(isLikelyBinary('server.go')).toBe(false);
        expect(isLikelyBinary('App.java')).toBe(false);
        expect(isLikelyBinary('main.rs')).toBe(false);
      });

      it('should pass through config files', () => {
        expect(isLikelyBinary('config.json')).toBe(false);
        expect(isLikelyBinary('settings.yaml')).toBe(false);
        expect(isLikelyBinary('docker-compose.yml')).toBe(false);
        expect(isLikelyBinary('.env')).toBe(false);
        expect(isLikelyBinary('Makefile')).toBe(false);
      });

      it('should pass through markup/text files', () => {
        expect(isLikelyBinary('README.md')).toBe(false);
        expect(isLikelyBinary('index.html')).toBe(false);
        expect(isLikelyBinary('styles.css')).toBe(false);
        expect(isLikelyBinary('data.xml')).toBe(false);
        expect(isLikelyBinary('notes.txt')).toBe(false);
      });

      it('should pass through log files', () => {
        expect(isLikelyBinary('server.log')).toBe(false);
        expect(isLikelyBinary('access.log')).toBe(false);
        expect(isLikelyBinary('error.log')).toBe(false);
      });
    });

    describe('case insensitivity', () => {
      it('should detect binary regardless of case', () => {
        expect(isLikelyBinary('IMAGE.JPG')).toBe(true);
        expect(isLikelyBinary('Photo.PNG')).toBe(true);
        expect(isLikelyBinary('ARCHIVE.ZIP')).toBe(true);
      });
    });
  });

  describe('parsePreviewUri', () => {
    it('should return null for non-preview scheme', () => {
      const uri = new Uri('file', '', '/some/path', '', '') as any;
      expect(parsePreviewUri(uri)).toBeNull();
    });

    it('should parse valid preview URI', () => {
      const uri = new Uri(
        PROGRESSIVE_PREVIEW_SCHEME,
        'conn1',
        '/%2Fhome%2Fuser%2Ffile.ts',
        'lines=500',
        ''
      ) as any;

      const result = parsePreviewUri(uri);
      expect(result).not.toBeNull();
      expect(result!.connectionId).toBe('conn1');
      expect(result!.lines).toBe(500);
    });

    it('should default to 1000 lines when not specified', () => {
      const uri = new Uri(
        PROGRESSIVE_PREVIEW_SCHEME,
        'conn1',
        '/path',
        '',
        ''
      ) as any;

      const result = parsePreviewUri(uri);
      expect(result).not.toBeNull();
      expect(result!.lines).toBe(1000);
    });

    it('should clamp lines to valid range (1-10000)', () => {
      // Test zero/negative
      const uriZero = new Uri(PROGRESSIVE_PREVIEW_SCHEME, 'c1', '/p', 'lines=0', '') as any;
      expect(parsePreviewUri(uriZero)!.lines).toBe(1);

      const uriNeg = new Uri(PROGRESSIVE_PREVIEW_SCHEME, 'c1', '/p', 'lines=-5', '') as any;
      expect(parsePreviewUri(uriNeg)!.lines).toBe(1);

      // Test above max
      const uriHigh = new Uri(PROGRESSIVE_PREVIEW_SCHEME, 'c1', '/p', 'lines=99999', '') as any;
      expect(parsePreviewUri(uriHigh)!.lines).toBe(10000);
    });

    it('should handle NaN lines gracefully', () => {
      const uri = new Uri(PROGRESSIVE_PREVIEW_SCHEME, 'c1', '/p', 'lines=abc', '') as any;
      expect(parsePreviewUri(uri)!.lines).toBe(1000);
    });
  });

  describe('createPreviewUri', () => {
    // Note: Uri.parse mock doesn't fully decompose URI strings,
    // so we test the constructed URI string format instead.

    it('should include scheme in URI string', () => {
      const uri = createPreviewUri('conn1', '/home/user/file.ts', 500);
      expect(uri.toString()).toContain(PROGRESSIVE_PREVIEW_SCHEME);
    });

    it('should include connection ID in URI string', () => {
      const uri = createPreviewUri('10.0.0.1:22:admin', '/path', 1000);
      expect(uri.toString()).toContain('10.0.0.1:22:admin');
    });

    it('should include lines parameter in URI string', () => {
      const uri = createPreviewUri('conn1', '/file.ts', 500);
      expect(uri.toString()).toContain('lines=500');
    });

    it('should default to 1000 lines', () => {
      const uri = createPreviewUri('conn1', '/file.ts');
      expect(uri.toString()).toContain('lines=1000');
    });

    it('should normalize path to start with /', () => {
      const uri = createPreviewUri('conn1', 'relative/path.ts', 500);
      expect(uri.toString()).toContain(encodeURIComponent('/relative/path.ts'));
    });

    it('should not double-slash paths already starting with /', () => {
      const uri = createPreviewUri('conn1', '/absolute/path.ts', 500);
      expect(uri.toString()).toContain(encodeURIComponent('/absolute/path.ts'));
    });
  });

  describe('loadProgressiveConfig', () => {
    it('should load with default values', () => {
      const config = loadProgressiveConfig();
      expect(config.threshold).toBe(DEFAULT_PROGRESSIVE_CONFIG.threshold);
      expect(config.previewLines).toBe(DEFAULT_PROGRESSIVE_CONFIG.previewLines);
      expect(config.tailFollowEnabled).toBe(DEFAULT_PROGRESSIVE_CONFIG.tailFollowEnabled);
      expect(config.tailPollInterval).toBe(DEFAULT_PROGRESSIVE_CONFIG.tailPollInterval);
      expect(config.chunkSize).toBe(DEFAULT_PROGRESSIVE_CONFIG.chunkSize);
    });
  });

  describe('DEFAULT_PROGRESSIVE_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_PROGRESSIVE_CONFIG.threshold).toBe(1 * 1024 * 1024); // 1MB
      expect(DEFAULT_PROGRESSIVE_CONFIG.previewLines).toBe(1000);
      expect(DEFAULT_PROGRESSIVE_CONFIG.tailFollowEnabled).toBe(true);
      expect(DEFAULT_PROGRESSIVE_CONFIG.tailPollInterval).toBe(1000);
      expect(DEFAULT_PROGRESSIVE_CONFIG.chunkSize).toBe(64 * 1024); // 64KB
    });
  });

  describe('PROGRESSIVE_PREVIEW_SCHEME', () => {
    it('should be ssh-lite-preview', () => {
      expect(PROGRESSIVE_PREVIEW_SCHEME).toBe('ssh-lite-preview');
    });
  });

  describe('BINARY_EXTENSIONS', () => {
    it('should be a Set', () => {
      expect(BINARY_EXTENSIONS instanceof Set).toBe(true);
    });

    it('should contain common binary extensions', () => {
      expect(BINARY_EXTENSIONS.has('.exe')).toBe(true);
      expect(BINARY_EXTENSIONS.has('.zip')).toBe(true);
      expect(BINARY_EXTENSIONS.has('.jpg')).toBe(true);
      expect(BINARY_EXTENSIONS.has('.pdf')).toBe(true);
    });

    it('should not contain text extensions', () => {
      expect(BINARY_EXTENSIONS.has('.ts')).toBe(false);
      expect(BINARY_EXTENSIONS.has('.js')).toBe(false);
      expect(BINARY_EXTENSIONS.has('.json')).toBe(false);
      expect(BINARY_EXTENSIONS.has('.md')).toBe(false);
    });
  });
});
