import * as path from 'path';
import { buildAuxTempFileName, buildLocalTempPath, getConnectionPrefix, registerTabLabel } from './connectionPrefix';

describe('buildLocalTempPath', () => {
  const tempDir = path.join('/tmp', 'ssh-lite');

  it('gives different paths to same-named files in different folders (issue #6)', () => {
    // Regression for the temp-file collision: two index.php files on the same
    // server but in different folders must not share one local temp file.
    const a = buildLocalTempPath(tempDir, 'conn-1', '/var/www/domainA/index.php');
    const b = buildLocalTempPath(tempDir, 'conn-1', '/var/www/domainB/index.php');

    expect(a.filePath).not.toBe(b.filePath);
    expect(a.dir).not.toBe(b.dir);
  });

  it('is deterministic for the same input', () => {
    const a = buildLocalTempPath(tempDir, 'conn-1', '/var/www/a/index.php');
    const b = buildLocalTempPath(tempDir, 'conn-1', '/var/www/a/index.php');

    expect(a.filePath).toBe(b.filePath);
  });

  it('separates different connections', () => {
    const a = buildLocalTempPath(tempDir, 'conn-1', '/x/index.php');
    const b = buildLocalTempPath(tempDir, 'conn-2', '/x/index.php');

    expect(a.filePath).not.toBe(b.filePath);
  });

  it('keeps the original basename, prefixed, as the filename', () => {
    const { filePath } = buildLocalTempPath(tempDir, '10.0.0.1:22:admin', '/var/www/site/index.php');

    expect(path.basename(filePath)).toBe('[admin@10.0.0.1] index.php');
  });

  it('honors a registered tab label in the filename prefix', () => {
    registerTabLabel('myhost:22:deploy', 'PRD');
    const { filePath } = buildLocalTempPath(tempDir, 'myhost:22:deploy', '/app/index.php');

    expect(path.basename(filePath)).toBe('[PRD] index.php');
    expect(getConnectionPrefix('myhost:22:deploy')).toBe('PRD');
  });

  it('embeds the remote folder name plus a hash in the subdirectory for readable tabs', () => {
    const { dir } = buildLocalTempPath(tempDir, 'conn-1', '/var/www/domainA/index.php');

    expect(path.basename(dir)).toMatch(/^domainA_[0-9a-f]{8}$/);
  });

  it('handles files at the filesystem root', () => {
    const { dir, filePath } = buildLocalTempPath(tempDir, 'conn-1', '/index.php');

    expect(path.basename(dir)).toMatch(/^root_[0-9a-f]{8}$/);
    expect(path.basename(filePath)).toContain('index.php');
  });

  it('sanitizes spaces and unsafe characters in folder names', () => {
    const { dir } = buildLocalTempPath(tempDir, 'conn-1', '/weird name/file.txt');

    expect(path.basename(dir)).toMatch(/^weird_name_[0-9a-f]{8}$/);
  });
});

describe('buildAuxTempFileName (view / diff / preview / backup-compare)', () => {
  it('gives different names to same-basename files in different folders (issue #6)', () => {
    const a = buildAuxTempFileName('view', 'conn-1', '/var/www/domainA/index.php');
    const b = buildAuxTempFileName('view', 'conn-1', '/var/www/domainB/index.php');

    expect(a).not.toBe(b);
  });

  it('gives different names to the same path on different servers', () => {
    const a = buildAuxTempFileName('view', 'serverA:22:u', '/var/www/index.php');
    const b = buildAuxTempFileName('view', 'serverB:22:u', '/var/www/index.php');

    expect(a).not.toBe(b);
  });

  it('separates different kinds (e.g. diff-old vs diff-new) for the same file', () => {
    const oldF = buildAuxTempFileName('diff-old', 'conn-1', '/a/x.php');
    const newF = buildAuxTempFileName('diff-new', 'conn-1', '/a/x.php');

    expect(oldF).not.toBe(newF);
  });

  it('is deterministic and keeps a readable basename suffix', () => {
    const a = buildAuxTempFileName('view', 'conn-1', '/a/index.php');
    const b = buildAuxTempFileName('view', 'conn-1', '/a/index.php');

    expect(a).toBe(b);
    expect(a).toMatch(/^view-[0-9a-f]{8}-index\.php$/);
  });
});
