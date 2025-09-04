#!/usr/bin/env node

/**
 * Specific test for empty context lines handling in GitHub comment position tracking
 * This addresses the critical bug where empty context lines weren't being counted properly
 */

const { GitHubClient } = require('./src/github/client');

// Create test instance
const client = new GitHubClient('dummy-token');

// Test diff with empty context lines (the critical bug scenario)
const testDiffWithEmptyContext = `diff --git a/test.js b/test.js
index 1234567..abcdefg 100644
--- a/test.js
+++ b/test.js
@@ -1,5 +1,7 @@
 function test() {
+    // Added comment
     console.log('test');

+    console.log('another line');
 }
@@ -10,4 +12,5 @@
 function another() {
     return true;
 }
+// Final comment`;

/**
 * Test cases specifically for empty context line handling
 */
const emptyContextTestCases = [
    {
        name: 'First addition after context',
        file: 'test.js',
        line: 2, // "// Added comment"
        expectedPosition: 2
    },
    {
        name: 'Empty context line',
        file: 'test.js',
        line: 4, // Empty line (blank context line)
        expectedPosition: 4 // This should count toward position
    },
    {
        name: 'Addition after empty context',
        file: 'test.js',
        line: 5, // "console.log('another line');"
        expectedPosition: 5
    },
    {
        name: 'Second hunk addition',
        file: 'test.js',
        line: 15, // "// Final comment" (corrected line number)
        expectedPosition: 10 // Should include the empty context line from first hunk
    }
];

/**
 * Run the empty context line tests
 */
function runEmptyContextTests() {
    console.log('🔬 Testing Empty Context Lines Handling');
    console.log('='.repeat(60));
    
    // First, analyze the structure to understand what we're testing
    console.log('\nDIFF STRUCTURE:');
    const lines = testDiffWithEmptyContext.split('\n');
    let position = 0;
    let inFile = false;
    let foundHunk = false;
    let newLineNumber = 0;
    
    lines.forEach((line, index) => {
        if (line.startsWith('diff --git')) {
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
                console.log(`📁 FILE: ${match[2]}`);
                position = 0;
                foundHunk = false;
                newLineNumber = 0;
            }
            return;
        }
        
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
            if (match) {
                newLineNumber = parseInt(match[1]) - 1;
                if (!foundHunk) {
                    position = 0;
                }
                foundHunk = true;
                console.log(`  🎯 HUNK: ${line}`);
            }
            return;
        }
        
        if (foundHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || (line === '' && foundHunk))) {
            position++;
            
            if (line.startsWith('+')) {
                newLineNumber++;
                console.log(`    Pos ${position}: Line ${newLineNumber} | + ${line.substring(1) || '(empty)'}`);
            } else if (line.startsWith(' ')) {
                newLineNumber++;
                console.log(`    Pos ${position}: Line ${newLineNumber} |   ${line.substring(1) || '(context)'}`);
            } else if (line === '' && foundHunk) {
                newLineNumber++;
                console.log(`    Pos ${position}: Line ${newLineNumber} |   (EMPTY CONTEXT LINE)`);
            } else if (line.startsWith('-')) {
                console.log(`    Pos ${position}: DELETED | - ${line.substring(1) || '(empty)'}`);
            }
        }
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('RUNNING TESTS:\n');
    
    let passed = 0;
    let failed = 0;
    
    emptyContextTestCases.forEach((testCase, index) => {
        console.log(`Test ${index + 1}: ${testCase.name}`);
        console.log(`File: ${testCase.file}, Line: ${testCase.line}`);
        
        const actualPosition = client.calculateDiffPosition(
            testDiffWithEmptyContext,
            testCase.file,
            testCase.line
        );
        
        console.log(`Expected: ${testCase.expectedPosition}, Got: ${actualPosition}`);
        
        if (actualPosition === testCase.expectedPosition) {
            console.log('✅ PASS\n');
            passed++;
        } else {
            console.log('❌ FAIL\n');
            failed++;
        }
    });
    
    console.log('='.repeat(60));
    console.log('SUMMARY:');
    console.log(`Total Tests: ${passed + failed}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
    
    return { passed, failed };
}

// Run the test
if (require.main === module) {
    const results = runEmptyContextTests();
    
    if (results.failed > 0) {
        console.log('\n❌ Some tests failed - empty context line handling needs fixes!');
        process.exit(1);
    } else {
        console.log('\n🎉 All empty context line tests passed!');
    }
}

module.exports = { runEmptyContextTests };