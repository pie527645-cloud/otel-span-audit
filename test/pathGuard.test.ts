import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  discoverProjectFiles,
  hasPosixBackslashTraversal,
  isWithinRoot,
  PathSecurityError,
  resolveSafePath,
} from '../src/index.js';

describe('pathGuard security & discovery boundaries', () => {
  it('explicitly rejects Windows-style ..\\ traversal on POSIX platforms', () => {
    assert.equal(hasPosixBackslashTraversal('..\\etc\\passwd', 'linux'), true);
    assert.equal(hasPosixBackslashTraversal('sub\\..\\escape.ts', 'darwin'), true);
    assert.equal(hasPosixBackslashTraversal('src/index.ts', 'linux'), false);
    assert.equal(hasPosixBackslashTraversal('..\\sibling\\file.ts', 'win32'), false);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-posix-guard-'));
    try {
      assert.throws(
        () => resolveSafePath('..\\outside.ts', tmpRoot, { platform: 'linux' }),
        (err: unknown) =>
          err instanceof PathSecurityError && err.code === 'PATH_TRAVERSAL_BLOCKED'
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes root and target parent via fs.realpathSync.native (Windows 8.3 short-path safe)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-realpath-83-longdirname-'));
    try {
      const nestedDir = path.join(tmpRoot, 'nested-long-directory-name');
      fs.mkdirSync(nestedDir, { recursive: true });
      const filePath = path.join(nestedDir, 'service.ts');
      fs.writeFileSync(filePath, 'export const ok = 1;\n', 'utf8');

      const resolved = resolveSafePath('nested-long-directory-name/service.ts', tmpRoot);
      const expectedNative = fs.realpathSync.native(filePath);
      assert.equal(resolved, expectedNative);
      assert.equal(isWithinRoot(fs.realpathSync.native(tmpRoot), resolved), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('blocks symlink/junction escapes outside scan root with SYMLINK_ESCAPE_BLOCKED', () => {
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-sym-root-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-sym-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const s = 1;\n', 'utf8');
      const linkPath = path.join(scanRoot, 'escaped-link');
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      assert.throws(
        () => discoverProjectFiles(scanRoot),
        (err: unknown) =>
          err instanceof PathSecurityError && err.code === 'SYMLINK_ESCAPE_BLOCKED'
      );
    } finally {
      fs.rmSync(scanRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('ignores test/, dist-tests/, out/, .next/, node_modules/, and *.d.ts unless --include-tests or directly targeted', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-discover-'));
    try {
      fs.mkdirSync(path.join(tmpProject, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpProject, 'dist-tests'), { recursive: true });
      fs.mkdirSync(path.join(tmpProject, 'out'), { recursive: true });
      fs.mkdirSync(path.join(tmpProject, '.next'), { recursive: true });
      fs.mkdirSync(path.join(tmpProject, 'node_modules', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(tmpProject, 'test'), { recursive: true });

      fs.writeFileSync(path.join(tmpProject, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmpProject, 'src', 'app.spec.ts'), 'export const s = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmpProject, 'src', 'types.d.ts'), 'export type T = string;\n', 'utf8');
      fs.writeFileSync(path.join(tmpProject, 'dist-tests', 'app.js'), 'export const d = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmpProject, 'out', 'bundle.js'), 'export const o = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmpProject, '.next', 'server.js'), 'export const n = 1;\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpProject, 'node_modules', 'pkg', 'index.js'),
        'export const p = 1;\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpProject, 'test', 'unit.test.ts'),
        'export const u = 1;\n',
        'utf8'
      );

      const defaultScan = discoverProjectFiles(tmpProject, { includeTests: false });
      assert.deepEqual(
        defaultScan.files.map((f) => f.displayPath),
        ['src/app.ts']
      );

      const withTestsScan = discoverProjectFiles(tmpProject, { includeTests: true });
      assert.deepEqual(
        withTestsScan.files.map((f) => f.displayPath),
        ['src/app.spec.ts', 'src/app.ts', 'test/unit.test.ts']
      );

      const directTestFile = discoverProjectFiles(path.join(tmpProject, 'test', 'unit.test.ts'));
      assert.equal(directTestFile.files.length, 1);
      assert.equal(directTestFile.files[0]?.displayPath, 'unit.test.ts');
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});
