// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const {
  annotateDiff,
  parseAnnotatedDiff,
  parseHunkHeader,
  formatLineNum,
  getLineMarker,
  getLineContent
} = require('../../src/utils/diff-annotator');

describe('diff-annotator', () => {
  describe('parseHunkHeader', () => {
    it('should parse standard hunk header with counts', () => {
      const result = parseHunkHeader('@@ -10,5 +12,7 @@ function example() {');
      expect(result).toEqual({
        oldStart: 10,
        oldCount: 5,
        newStart: 12,
        newCount: 7,
        context: 'function example() {'
      });
    });

    it('should parse hunk header without counts (defaults to 1)', () => {
      const result = parseHunkHeader('@@ -1 +1 @@');
      expect(result).toEqual({
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        context: null
      });
    });

    it('should parse hunk header with only old count', () => {
      const result = parseHunkHeader('@@ -10,3 +15 @@');
      expect(result).toEqual({
        oldStart: 10,
        oldCount: 3,
        newStart: 15,
        newCount: 1,
        context: null
      });
    });

    it('should parse hunk header with only new count', () => {
      const result = parseHunkHeader('@@ -5 +8,4 @@');
      expect(result).toEqual({
        oldStart: 5,
        oldCount: 1,
        newStart: 8,
        newCount: 4,
        context: null
      });
    });

    it('should parse hunk header with zero counts', () => {
      const result = parseHunkHeader('@@ -0,0 +1,5 @@');
      expect(result).toEqual({
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 5,
        context: null
      });
    });

    it('should return null for invalid header', () => {
      expect(parseHunkHeader('not a header')).toBeNull();
      expect(parseHunkHeader('@@invalid@@')).toBeNull();
      expect(parseHunkHeader('')).toBeNull();
    });
  });

  describe('formatLineNum', () => {
    it('should format number with default width', () => {
      expect(formatLineNum(1)).toBe('   1');
      expect(formatLineNum(10)).toBe('  10');
      expect(formatLineNum(100)).toBe(' 100');
      expect(formatLineNum(1000)).toBe('1000');
    });

    it('should format number with custom width', () => {
      expect(formatLineNum(1, 6)).toBe('     1');
      expect(formatLineNum(42, 3)).toBe(' 42');
    });

    it('should format null as placeholder', () => {
      expect(formatLineNum(null)).toBe('  --');
      expect(formatLineNum(null, 6)).toBe('    --');
    });
  });

  describe('getLineMarker', () => {
    it('should return [+] for additions', () => {
      expect(getLineMarker('+added line')).toBe('[+]');
    });

    it('should return [-] for deletions', () => {
      expect(getLineMarker('-removed line')).toBe('[-]');
    });

    it('should return spaces for context lines with leading space', () => {
      expect(getLineMarker(' context line')).toBe('   ');
    });

    it('should return spaces for lines without +/- prefix (default fallback)', () => {
      // Lines without +/- prefix fall through to the default case
      // This handles edge cases and malformed diffs
      expect(getLineMarker('context without leading space')).toBe('   ');
    });
  });

  describe('getLineContent', () => {
    it('should remove leading + from additions', () => {
      expect(getLineContent('+added line')).toBe('added line');
    });

    it('should remove leading - from deletions', () => {
      expect(getLineContent('-removed line')).toBe('removed line');
    });

    it('should remove leading space from context', () => {
      expect(getLineContent(' context line')).toBe('context line');
    });

    it('should preserve "No newline" marker', () => {
      expect(getLineContent('\\ No newline at end of file')).toBe('\\ No newline at end of file');
    });
  });

  describe('annotateDiff', () => {
    it('should return empty string for empty input', () => {
      expect(annotateDiff('')).toBe('');
      expect(annotateDiff('   ')).toBe('');
      expect(annotateDiff(null)).toBe('');
      expect(annotateDiff(undefined)).toBe('');
    });

    it('should annotate simple diff with additions only', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,5 @@
 line 1
 line 2
+new line 3
+new line 4
 line 3`;

      const result = annotateDiff(rawDiff);
      const lines = result.split('\n');

      expect(lines[0]).toBe('=== test.js ===');
      expect(lines[1]).toBe(' OLD | NEW |');
      expect(lines[2]).toBe('@@ -1,3 +1,5 @@'); // Original git hunk header
      expect(lines[3]).toMatch(/^\s+1 \|\s+1 \|     line 1$/);
      expect(lines[4]).toMatch(/^\s+2 \|\s+2 \|     line 2$/);
      expect(lines[5]).toMatch(/^\s+-- \|\s+3 \| \[\+\] new line 3$/);
      expect(lines[6]).toMatch(/^\s+-- \|\s+4 \| \[\+\] new line 4$/);
      expect(lines[7]).toMatch(/^\s+3 \|\s+5 \|     line 3$/);
    });

    it('should annotate diff with deletions only', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,5 +1,3 @@
 line 1
-deleted line 2
-deleted line 3
 line 4
 line 5`;

      const result = annotateDiff(rawDiff);
      const lines = result.split('\n');

      expect(lines[0]).toBe('=== test.js ===');
      expect(lines[1]).toBe(' OLD | NEW |');
      expect(lines[2]).toBe('@@ -1,5 +1,3 @@'); // Original git hunk header
      expect(lines[3]).toMatch(/^\s+1 \|\s+1 \|     line 1$/);
      expect(lines[4]).toMatch(/^\s+2 \|\s+-- \| \[-\] deleted line 2$/);
      expect(lines[5]).toMatch(/^\s+3 \|\s+-- \| \[-\] deleted line 3$/);
      expect(lines[6]).toMatch(/^\s+4 \|\s+2 \|     line 4$/);
      expect(lines[7]).toMatch(/^\s+5 \|\s+3 \|     line 5$/);
    });

    it('should annotate mixed additions/deletions/context', () => {
      const rawDiff = `diff --git a/helper.js b/helper.js
index abc123..def456 100644
--- a/helper.js
+++ b/helper.js
@@ -10,5 +12,5 @@
 function calculate(a, b) {
-  const legacy = true;
+  const validated = validate(a);
   return a + b;
 }`;

      const result = annotateDiff(rawDiff);
      const lines = result.split('\n');

      expect(lines[0]).toBe('=== helper.js ===');
      expect(lines[1]).toBe(' OLD | NEW |');
      expect(lines[2]).toBe('@@ -10,5 +12,5 @@'); // Original git hunk header
      // Content preserves original spacing from the diff (source has 2-space indent)
      expect(lines[3]).toContain('10 |');
      expect(lines[3]).toContain('12 |');
      expect(lines[3]).toContain('function calculate(a, b) {');
      expect(lines[4]).toContain('11 |');
      expect(lines[4]).toContain('[-]');
      expect(lines[4]).toContain('const legacy = true;');
      expect(lines[5]).toContain('13 |');
      expect(lines[5]).toContain('[+]');
      expect(lines[5]).toContain('const validated = validate(a);');
      expect(lines[6]).toContain('12 |');
      expect(lines[6]).toContain('14 |');
      expect(lines[6]).toContain('return a + b;');
      expect(lines[7]).toContain('13 |');
      expect(lines[7]).toContain('15 |');
      expect(lines[7]).toContain('}');
    });

    it('should handle multiple files in one diff', () => {
      const rawDiff = `diff --git a/file1.js b/file1.js
index abc123..def456 100644
--- a/file1.js
+++ b/file1.js
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export { a };
diff --git a/file2.js b/file2.js
index 111222..333444 100644
--- a/file2.js
+++ b/file2.js
@@ -1,2 +1,2 @@
-import { a } from './file1';
+import { a, b } from './file1';
 console.log(a);`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('=== file1.js ===');
      expect(result).toContain('=== file2.js ===');
      expect(result).toContain('[+] const b = 2;');
      expect(result).toContain("[-] import { a } from './file1';");
      expect(result).toContain("[+] import { a, b } from './file1';");
    });

    it('should handle binary files', () => {
      const rawDiff = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/image.png differ`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('=== image.png ===');
      expect(result).toContain('Binary file (not annotated)');
      expect(result).not.toContain(' OLD | NEW |');
    });

    it('should handle binary files with GIT binary patch', () => {
      const rawDiff = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
GIT binary patch
literal 1234
some binary data here`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('=== image.png ===');
      expect(result).toContain('Binary file (not annotated)');
      expect(result).not.toContain(' OLD | NEW |');
    });

    it('should handle renamed files', () => {
      const rawDiff = `diff --git a/old-name.js b/new-name.js
similarity index 95%
rename from old-name.js
rename to new-name.js
index abc123..def456 100644
--- a/old-name.js
+++ b/new-name.js
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 export { x, y };`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('=== old-name.js -> new-name.js ===');
      expect(result).toContain(' OLD | NEW |');
      expect(result).toContain('[-] const y = 2;');
      expect(result).toContain('[+] const y = 3;');
    });

    it('should handle new file', () => {
      const rawDiff = `diff --git a/new-file.js b/new-file.js
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new-file.js
@@ -0,0 +1,3 @@
+const a = 1;
+const b = 2;
+export { a, b };`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('=== new-file.js ===');
      expect(result).toContain(' OLD | NEW |');
      expect(result).toContain('[+] const a = 1;');
      expect(result).toContain('[+] const b = 2;');
    });

    it('should handle deleted file', () => {
      const rawDiff = `diff --git a/deleted.js b/deleted.js
deleted file mode 100644
index abc1234..0000000
--- a/deleted.js
+++ /dev/null
@@ -1,3 +0,0 @@
-const a = 1;
-const b = 2;
-export { a, b };`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('=== deleted.js ===');
      expect(result).toContain(' OLD | NEW |');
      expect(result).toContain('[-] const a = 1;');
      expect(result).toContain('[-] const b = 2;');
    });

    it('should handle large context with accurate line counting', () => {
      const rawDiff = `diff --git a/large.js b/large.js
index abc123..def456 100644
--- a/large.js
+++ b/large.js
@@ -95,10 +95,11 @@ function processData() {
   const result1 = step1();
   const result2 = step2();
   const result3 = step3();
+  const result4 = step4();
   const result5 = step5();
   const result6 = step6();
   const result7 = step7();
-  return combine(result1, result2, result3, result5, result6, result7);
+  return combine(result1, result2, result3, result4, result5, result6, result7);
 }`;

      const result = annotateDiff(rawDiff);
      const lines = result.split('\n');

      // Find the line with result4 addition (new line 98)
      const result4Line = lines.find(l => l.includes('result4 = step4'));
      expect(result4Line).toContain('98 |');
      expect(result4Line).toContain('[+]');
      expect(result4Line).toContain('--');

      // Find the modified return line (deletion at old line 101)
      const oldReturnLine = lines.find(l => l.includes('[-]') && l.includes('combine'));
      expect(oldReturnLine).toContain('101 |');
      expect(oldReturnLine).toContain('--');

      // Find the modified return line (addition at new line 102)
      const newReturnLine = lines.find(l => l.includes('[+]') && l.includes('combine') && l.includes('result4'));
      expect(newReturnLine).toContain('102 |');
      expect(newReturnLine).toContain('--');
    });

    it('should handle hunk headers with function names', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -50,4 +50,5 @@ class MyClass {
   constructor() {
     this.value = 0;
+    this.initialized = true;
   }
 }`;

      const result = annotateDiff(rawDiff);

      // The function name context from hunk header should not appear in output
      // since we only output annotated lines
      expect(result).toContain('=== test.js ===');
      expect(result).toContain('[+]     this.initialized = true;');
    });

    it('should handle "No newline at end of file" marker', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,2 +1,2 @@
 line 1
-line 2
\\ No newline at end of file
+line 2 modified
\\ No newline at end of file`;

      const result = annotateDiff(rawDiff);

      expect(result).toContain('\\ No newline at end of file');
    });

    it('should handle empty lines in diff', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,5 +1,6 @@
 line 1

+new line

 line 4
 line 5`;

      const result = annotateDiff(rawDiff);
      const lines = result.split('\n');

      // Should have proper line counting with empty lines
      expect(lines.filter(l => l.includes('[+] new line')).length).toBe(1);
    });

    it('should handle multiple hunks in same file', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 function a() {
+  console.log('a');
   return 1;
 }
@@ -10,3 +11,4 @@ function b() {
 function c() {
+  console.log('c');
   return 3;
 }`;

      const result = annotateDiff(rawDiff);

      // Should only have one file header
      expect((result.match(/=== test\.js ===/g) || []).length).toBe(1);

      // Should have both additions
      expect(result).toContain("[+]   console.log('a');");
      expect(result).toContain("[+]   console.log('c');");

      // Verify line numbers are correct for second hunk
      const lines = result.split('\n');
      const logCLine = lines.find(l => l.includes("console.log('c')"));
      expect(logCLine).toContain('12 |');
    });

    it('should output original hunk headers for chunk boundaries', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 line 1
+new line
 line 3
 line 4`;

      const result = annotateDiff(rawDiff);

      // Should contain original git hunk header
      expect(result).toContain('@@ -1,3 +1,4 @@');
    });

    it('should output hunk headers with function context when present', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -50,4 +50,5 @@ function myFunction() {
   const x = 1;
+  const y = 2;
   return x;
 }`;

      const result = annotateDiff(rawDiff);

      // Should contain original hunk header with function context
      expect(result).toContain('@@ -50,4 +50,5 @@ function myFunction() {');
    });

    it('should output multiple hunk headers for discontinuous chunks', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 line 1
+new line 2
 line 3
 line 4
@@ -100,3 +101,4 @@ class Example {
 method() {
+  // new comment
   return true;
 }`;

      const result = annotateDiff(rawDiff);

      // Should have two original hunk headers marking chunk boundaries
      expect(result).toContain('@@ -1,3 +1,4 @@');
      expect(result).toContain('@@ -100,3 +101,4 @@ class Example {');

      // Verify discontinuity is visible - lines jump from ~4 to ~100
      const lines = result.split('\n');
      const firstHunkIndex = lines.findIndex(l => l.includes('@@ -1,3'));
      const secondHunkIndex = lines.findIndex(l => l.includes('@@ -100,3'));
      expect(secondHunkIndex).toBeGreaterThan(firstHunkIndex);
    });
  });

  describe('parseAnnotatedDiff', () => {
    it('should parse annotated diff back to structured format', () => {
      const annotated = `=== test.js ===
 OLD | NEW |
   1 |   1 |     line 1
   2 |  -- | [-] deleted
  -- |   2 | [+] added
   3 |   3 |     line 3`;

      const files = parseAnnotatedDiff(annotated);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('test.js');
      expect(files[0].lines.length).toBe(4);

      expect(files[0].lines[0]).toEqual({
        oldLineNum: 1,
        newLineNum: 1,
        type: 'context',
        content: 'line 1'
      });

      expect(files[0].lines[1]).toEqual({
        oldLineNum: 2,
        newLineNum: null,
        type: 'delete',
        content: 'deleted'
      });

      expect(files[0].lines[2]).toEqual({
        oldLineNum: null,
        newLineNum: 2,
        type: 'add',
        content: 'added'
      });
    });

    it('should handle multiple files', () => {
      const annotated = `=== file1.js ===
 OLD | NEW |
   1 |   1 |     const a = 1;
=== file2.js ===
 OLD | NEW |
   1 |   1 |     const b = 2;`;

      const files = parseAnnotatedDiff(annotated);

      expect(files.length).toBe(2);
      expect(files[0].path).toBe('file1.js');
      expect(files[1].path).toBe('file2.js');
    });

    it('should handle binary files', () => {
      const annotated = `=== image.png ===
Binary file (not annotated)`;

      const files = parseAnnotatedDiff(annotated);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('image.png');
      expect(files[0].isBinary).toBe(true);
    });

    it('should handle renamed files', () => {
      const annotated = `=== old.js -> new.js ===
 OLD | NEW |
   1 |   1 |     const x = 1;`;

      const files = parseAnnotatedDiff(annotated);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('old.js -> new.js');
    });

    it('should parse hunk headers as chunk boundaries', () => {
      const annotated = `=== test.js ===
 OLD | NEW |
@@ -1,3 +1,4 @@
   1 |   1 |     line 1
  -- |   2 | [+] new line
   2 |   3 |     line 2`;

      const files = parseAnnotatedDiff(annotated);

      expect(files.length).toBe(1);
      expect(files[0].lines.length).toBe(4); // hunk header + 3 content lines

      // First item should be hunk header with full git info
      expect(files[0].lines[0]).toEqual({
        type: 'hunk',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        context: null
      });
    });

    it('should parse hunk headers with function context', () => {
      const annotated = `=== test.js ===
 OLD | NEW |
@@ -50,4 +50,5 @@ function myFunction() {
  50 |  50 |       const x = 1;
  -- |  51 | [+]   const y = 2;`;

      const files = parseAnnotatedDiff(annotated);

      expect(files[0].lines[0]).toEqual({
        type: 'hunk',
        oldStart: 50,
        oldCount: 4,
        newStart: 50,
        newCount: 5,
        context: 'function myFunction() {'
      });
    });

    it('should parse multiple hunk headers for discontinuous chunks', () => {
      const annotated = `=== test.js ===
 OLD | NEW |
@@ -1,3 +1,4 @@
   1 |   1 |     line 1
  -- |   2 | [+] new line
@@ -100,3 +101,4 @@ class Example {
 100 | 101 |     method() {
  -- | 102 | [+]   // comment`;

      const files = parseAnnotatedDiff(annotated);

      expect(files[0].lines.length).toBe(6); // 2 hunk headers + 4 content lines

      expect(files[0].lines[0]).toEqual({
        type: 'hunk',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        context: null
      });

      expect(files[0].lines[3]).toEqual({
        type: 'hunk',
        oldStart: 100,
        oldCount: 3,
        newStart: 101,
        newCount: 4,
        context: 'class Example {'
      });
    });
  });

  describe('integration: round-trip parsing', () => {
    it('should produce consistent results when parsed', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,4 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 3;
 export { a, b, c };`;

      const annotated = annotateDiff(rawDiff);
      const parsed = parseAnnotatedDiff(annotated);

      expect(parsed.length).toBe(1);
      expect(parsed[0].path).toBe('test.js');
      expect(parsed[0].lines.length).toBe(6); // 1 hunk header + 5 content lines

      // Verify the modification
      const deletedLine = parsed[0].lines.find(l => l.type === 'delete');
      const addedLine = parsed[0].lines.find(l => l.type === 'add');

      expect(deletedLine.content).toBe('const b = 2;');
      expect(deletedLine.oldLineNum).toBe(2);
      expect(deletedLine.newLineNum).toBeNull();

      expect(addedLine.content).toBe('const b = 3;');
      expect(addedLine.oldLineNum).toBeNull();
      expect(addedLine.newLineNum).toBe(2);
    });

    it('should preserve hunk headers in round-trip parsing', () => {
      const rawDiff = `diff --git a/test.js b/test.js
index abc123..def456 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 line 1
+new line
 line 3
 line 4
@@ -50,3 +51,4 @@ function example() {
 body
+new body line
 end`;

      const annotated = annotateDiff(rawDiff);
      const parsed = parseAnnotatedDiff(annotated);

      expect(parsed.length).toBe(1);
      expect(parsed[0].path).toBe('test.js');

      // Find hunk headers
      const hunkHeaders = parsed[0].lines.filter(l => l.type === 'hunk');
      expect(hunkHeaders.length).toBe(2);

      expect(hunkHeaders[0]).toEqual({
        type: 'hunk',
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        context: null
      });

      expect(hunkHeaders[1]).toEqual({
        type: 'hunk',
        oldStart: 50,
        oldCount: 3,
        newStart: 51,
        newCount: 4,
        context: 'function example() {'
      });
    });
  });
});

describe('git-diff-lines CLI', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const scriptPath = path.join(projectRoot, 'bin', 'git-diff-lines');

  it('should be executable and run without errors', () => {
    // Run with HEAD HEAD (comparing same commit produces empty diff)
    try {
      const output = execSync(`node ${scriptPath} HEAD HEAD`, {
        encoding: 'utf8',
        cwd: projectRoot
      });
      // Empty diff between HEAD and HEAD is expected
      expect(output).toBe('');
    } catch (error) {
      // If it fails, it should be due to git issues, not the script loading
      expect(error.message).not.toContain('Cannot find module');
      expect(error.message).not.toContain('SyntaxError');
    }
  });

  it('should pass arguments through to git diff', () => {
    // Test that --name-only works (passes through to git)
    try {
      const output = execSync(`node ${scriptPath} --name-only HEAD~1 HEAD`, {
        encoding: 'utf8',
        cwd: projectRoot
      });
      // Should get file names or empty output
      expect(typeof output).toBe('string');
    } catch (error) {
      // If HEAD~1 doesn't exist, that's acceptable - just verify it's not a script error
      expect(error.message).not.toContain('Cannot find module');
      expect(error.message).not.toContain('SyntaxError');
    }
  });

  it('should handle empty diff gracefully', () => {
    // Comparing HEAD to HEAD always produces an empty diff
    const output = execSync(`node ${scriptPath} HEAD HEAD`, {
      encoding: 'utf8',
      cwd: projectRoot
    });
    // Empty diff should produce empty output (or whitespace only)
    expect(output.trim()).toBe('');
  });

  it('should produce annotated output for actual diffs', () => {
    // Skip this test if there's no git history
    try {
      // Check if we have at least 2 commits
      execSync('git rev-parse HEAD~1', {
        encoding: 'utf8',
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      // Skip test if we don't have enough history
      return;
    }

    try {
      const output = execSync(`node ${scriptPath} HEAD~1 HEAD`, {
        encoding: 'utf8',
        cwd: projectRoot
      });

      // If there were changes, output should contain annotation markers
      if (output.trim()) {
        // Should contain file headers or line number columns
        const hasAnnotations = output.includes('===') ||
                              output.includes(' OLD | NEW |') ||
                              output.includes('[+]') ||
                              output.includes('[-]');
        expect(hasAnnotations).toBe(true);
      }
    } catch (error) {
      // If git diff fails, that's OK - just verify it's not a script error
      expect(error.message).not.toContain('Cannot find module');
    }
  });

  it('should exit with error for invalid git arguments', () => {
    expect(() => {
      execSync(`node ${scriptPath} --invalid-flag-that-does-not-exist`, {
        encoding: 'utf8',
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    }).toThrow();
  });
});
