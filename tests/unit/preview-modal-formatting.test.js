// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

// Import the actual PreviewModal class from production code
const { PreviewModal } = require('../../public/js/components/PreviewModal.js');

// Use the static formatComments method from the actual implementation
const formatComments = PreviewModal.formatComments;

describe('PreviewModal - formatComments', () => {
  describe('Empty/null handling', () => {
    it('should return default message for empty array', () => {
      const result = formatComments([]);
      expect(result).toBe('No comments to preview.');
    });

    it('should return default message for null', () => {
      const result = formatComments(null);
      expect(result).toBe('No comments to preview.');
    });

    it('should return default message for undefined', () => {
      const result = formatComments(undefined);
      expect(result).toBe('No comments to preview.');
    });
  });

  describe('Single file scenarios', () => {
    it('should format single file with one file-level comment', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'This is a file-level comment',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## src/app.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'This is a file-level comment\n'
      );
    });

    it('should format single file with one line-level comment', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'This is a line comment',
          line_start: 123,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## src/app.js\n' +
        '\n' +
        '### Line Comment (line 123):\n' +
        'This is a line comment\n'
      );
    });

    it('should format single file with one line-level comment (undefined is_file_level)', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'This is a line comment',
          line_start: 42
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## src/app.js\n' +
        '\n' +
        '### Line Comment (line 42):\n' +
        'This is a line comment\n'
      );
    });

    it('should format single file with multiple file-level comments', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'First file comment',
          is_file_level: 1
        },
        {
          file: 'src/app.js',
          body: 'Second file comment',
          is_file_level: 1
        },
        {
          file: 'src/app.js',
          body: 'Third file comment',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## src/app.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'First file comment\n' +
        '\n' +
        '### File Comment 2:\n' +
        'Second file comment\n' +
        '\n' +
        '### File Comment 3:\n' +
        'Third file comment\n'
      );
    });

    it('should format single file with multiple line-level comments (sorted by line number)', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'Comment on line 50',
          line_start: 50,
          is_file_level: 0
        },
        {
          file: 'src/app.js',
          body: 'Comment on line 10',
          line_start: 10,
          is_file_level: 0
        },
        {
          file: 'src/app.js',
          body: 'Comment on line 30',
          line_start: 30,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## src/app.js\n' +
        '\n' +
        '### Line Comment (line 10):\n' +
        'Comment on line 10\n' +
        '\n' +
        '### Line Comment (line 30):\n' +
        'Comment on line 30\n' +
        '\n' +
        '### Line Comment (line 50):\n' +
        'Comment on line 50\n'
      );
    });

    it('should format single file with mixed comment types (file-level first, then line-level)', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'Line comment',
          line_start: 20,
          is_file_level: 0
        },
        {
          file: 'src/app.js',
          body: 'File comment',
          is_file_level: 1
        },
        {
          file: 'src/app.js',
          body: 'Another line comment',
          line_start: 10,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## src/app.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'File comment\n' +
        '\n' +
        '### Line Comment (line 10):\n' +
        'Another line comment\n' +
        '\n' +
        '### Line Comment (line 20):\n' +
        'Line comment\n'
      );
    });
  });

  describe('Multiple file scenarios', () => {
    it('should sort files alphabetically', () => {
      const comments = [
        {
          file: 'src/utils.js',
          body: 'Utils comment',
          is_file_level: 1
        },
        {
          file: 'src/app.js',
          body: 'App comment',
          is_file_level: 1
        },
        {
          file: 'README.md',
          body: 'Readme comment',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## README.md\n' +
        '\n' +
        '### File Comment 1:\n' +
        'Readme comment\n' +
        '\n' +
        '## src/app.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'App comment\n' +
        '\n' +
        '## src/utils.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'Utils comment\n'
      );
    });

    it('should add blank line between file sections', () => {
      const comments = [
        {
          file: 'a.js',
          body: 'First file',
          is_file_level: 1
        },
        {
          file: 'b.js',
          body: 'Second file',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      // Check that there's a blank line between file sections
      expect(result).toContain('First file\n\n## b.js');
    });

    it('should handle files with different comment types', () => {
      const comments = [
        {
          file: 'file1.js',
          body: 'File-level comment',
          is_file_level: 1
        },
        {
          file: 'file2.js',
          body: 'Line comment',
          line_start: 15,
          is_file_level: 0
        },
        {
          file: 'file3.js',
          body: 'Another file comment',
          is_file_level: 1
        },
        {
          file: 'file3.js',
          body: 'Another line comment',
          line_start: 25,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## file1.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'File-level comment\n' +
        '\n' +
        '## file2.js\n' +
        '\n' +
        '### Line Comment (line 15):\n' +
        'Line comment\n' +
        '\n' +
        '## file3.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        'Another file comment\n' +
        '\n' +
        '### Line Comment (line 25):\n' +
        'Another line comment\n'
      );
    });
  });

  describe('Line number formatting', () => {
    it('should format single line comment', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Single line',
          line_start: 123,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 123):');
    });

    it('should format line range when line_end differs from line_start', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Line range',
          line_start: 123,
          line_end: 125,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (lines 123-125):');
    });

    it('should format as single line when line_end equals line_start', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Same line',
          line_start: 100,
          line_end: 100,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 100):');
    });

    it('should handle missing line_end (falsy)', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'No line_end',
          line_start: 50,
          line_end: null,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 50):');
    });

    it('should sort line comments by line_start', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Third',
          line_start: 300,
          is_file_level: 0
        },
        {
          file: 'test.js',
          body: 'First',
          line_start: 100,
          is_file_level: 0
        },
        {
          file: 'test.js',
          body: 'Second',
          line_start: 200,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      const firstIndex = result.indexOf('line 100');
      const secondIndex = result.indexOf('line 200');
      const thirdIndex = result.indexOf('line 300');
      expect(firstIndex).toBeLessThan(secondIndex);
      expect(secondIndex).toBeLessThan(thirdIndex);
    });
  });

  describe('Comment body handling', () => {
    it('should preserve multi-line comment bodies', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Line 1\nLine 2\nLine 3',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('Line 1\nLine 2\nLine 3');
    });

    it('should handle empty comment bodies', () => {
      const comments = [
        {
          file: 'test.js',
          body: '',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toBe(
        '## test.js\n' +
        '\n' +
        '### File Comment 1:\n' +
        '\n'
      );
    });

    it('should preserve markdown special characters', () => {
      const comments = [
        {
          file: 'test.js',
          body: '**Bold** _italic_ `code` [link](url) # heading',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('**Bold** _italic_ `code` [link](url) # heading');
    });

    it('should handle very long bodies', () => {
      const longBody = 'A'.repeat(5000);
      const comments = [
        {
          file: 'test.js',
          body: longBody,
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain(longBody);
      expect(result.length).toBeGreaterThan(5000);
    });

    it('should handle bodies with special whitespace', () => {
      const comments = [
        {
          file: 'test.js',
          body: '  Leading spaces\n\tTabs\nTrailing spaces  ',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('  Leading spaces\n\tTabs\nTrailing spaces  ');
    });
  });

  describe('Markdown structure', () => {
    it('should use ## for file headers', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Comment',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toMatch(/^## test\.js\n/);
    });

    it('should use ### for comment headers', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Comment',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### File Comment 1:');
    });

    it('should use "File Comment N" format with numbering', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'First',
          is_file_level: 1
        },
        {
          file: 'test.js',
          body: 'Second',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### File Comment 1:');
      expect(result).toContain('### File Comment 2:');
    });

    it('should use "Line Comment (line X)" format', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Comment',
          line_start: 42,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 42):');
    });

    it('should use "Line Comment (lines X-Y)" format for ranges', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Comment',
          line_start: 10,
          line_end: 20,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (lines 10-20):');
    });

    it('should add blank line before each comment header', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'First comment',
          is_file_level: 1
        },
        {
          file: 'test.js',
          body: 'Second comment',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      // Both file comments should have a blank line before their header
      expect(result).toContain('## test.js\n\n### File Comment 1:');
      expect(result).toContain('First comment\n\n### File Comment 2:');
    });
  });

  describe('is_file_level flag handling', () => {
    it('should treat is_file_level === 1 as file-level comment', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'File level',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### File Comment 1:');
      expect(result).not.toContain('Line Comment');
    });

    it('should treat is_file_level === 0 as line-level comment', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Line level',
          line_start: 10,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 10):');
      expect(result).not.toContain('File Comment');
    });

    it('should treat undefined is_file_level as line-level comment', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Line level',
          line_start: 10
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 10):');
      expect(result).not.toContain('File Comment');
    });

    it('should correctly separate file-level and line-level comments in same file', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'File comment 1',
          is_file_level: 1
        },
        {
          file: 'test.js',
          body: 'Line comment',
          line_start: 5,
          is_file_level: 0
        },
        {
          file: 'test.js',
          body: 'File comment 2',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);

      // File-level comments should appear first
      const fileComment1Index = result.indexOf('### File Comment 1:');
      const fileComment2Index = result.indexOf('### File Comment 2:');
      const lineCommentIndex = result.indexOf('### Line Comment');

      expect(fileComment1Index).toBeGreaterThan(-1);
      expect(fileComment2Index).toBeGreaterThan(-1);
      expect(lineCommentIndex).toBeGreaterThan(-1);

      // Both file comments should come before line comment
      expect(fileComment1Index).toBeLessThan(lineCommentIndex);
      expect(fileComment2Index).toBeLessThan(lineCommentIndex);
    });
  });

  describe('Complex real-world scenarios', () => {
    it('should handle a complex multi-file review', () => {
      const comments = [
        {
          file: 'src/components/Button.jsx',
          body: 'Consider using PropTypes for type checking',
          is_file_level: 1
        },
        {
          file: 'src/components/Button.jsx',
          body: 'This onClick handler should be memoized',
          line_start: 25,
          line_end: 27,
          is_file_level: 0
        },
        {
          file: 'README.md',
          body: 'Update installation instructions',
          line_start: 10,
          is_file_level: 0
        },
        {
          file: 'package.json',
          body: 'Missing test script',
          is_file_level: 1
        },
        {
          file: 'package.json',
          body: 'Consider updating React to latest version',
          is_file_level: 1
        },
        {
          file: 'src/components/Button.jsx',
          body: 'Missing accessibility attributes',
          line_start: 15,
          is_file_level: 0
        }
      ];

      const result = formatComments(comments);

      // Files should be alphabetically sorted
      expect(result.indexOf('## README.md')).toBeLessThan(result.indexOf('## package.json'));
      expect(result.indexOf('## package.json')).toBeLessThan(result.indexOf('## src/components/Button.jsx'));

      // Button.jsx should have file comment first, then line comments sorted
      const buttonSection = result.substring(result.indexOf('## src/components/Button.jsx'));
      expect(buttonSection.indexOf('File Comment 1:')).toBeLessThan(buttonSection.indexOf('Line Comment (line 15)'));
      expect(buttonSection.indexOf('Line Comment (line 15)')).toBeLessThan(buttonSection.indexOf('Line Comment (lines 25-27)'));

      // package.json should have both file comments numbered
      const packageSection = result.substring(
        result.indexOf('## package.json'),
        result.indexOf('## src/components/Button.jsx')
      );
      expect(packageSection).toContain('File Comment 1:');
      expect(packageSection).toContain('File Comment 2:');
    });

    it('should handle edge case: comment with line_start = 0', () => {
      const comments = [
        {
          file: 'test.js',
          body: 'Comment at line 0',
          line_start: 0,
          is_file_level: 0
        }
      ];
      const result = formatComments(comments);
      expect(result).toContain('### Line Comment (line 0):');
    });

    it('should maintain order when files have similar prefixes', () => {
      const comments = [
        {
          file: 'src/app.js',
          body: 'App',
          is_file_level: 1
        },
        {
          file: 'src/app-utils.js',
          body: 'Utils',
          is_file_level: 1
        },
        {
          file: 'src/app/index.js',
          body: 'Index',
          is_file_level: 1
        }
      ];
      const result = formatComments(comments);

      // Check alphabetical order
      expect(result.indexOf('## src/app-utils.js')).toBeLessThan(result.indexOf('## src/app.js'));
      expect(result.indexOf('## src/app.js')).toBeLessThan(result.indexOf('## src/app/index.js'));
    });
  });
});
