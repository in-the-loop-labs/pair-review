#!/usr/bin/env node

/**
 * Comprehensive test for GitHub comment position tracking
 * Tests both backend calculateDiffPosition and frontend fileDiffPosition logic
 */

const fs = require('fs');
const path = require('path');

// Import the GitHubClient for testing
const { GitHubClient } = require('./src/github/client');

// Create test instance
const client = new GitHubClient('dummy-token');

// Test data: complex diff with multiple files and hunks
const testDiff = `diff --git a/file1.js b/file1.js
index 1234567..abcdefg 100644
--- a/file1.js
+++ b/file1.js
@@ -1,4 +1,6 @@
 function hello() {
+    // New comment
     console.log('hello');
+    console.log('world');
 }
 
@@ -10,7 +12,8 @@
     return x + y;
 }
 
+// Another addition
 function multiply(x, y) {
     return x * y;
 }
diff --git a/file2.js b/file2.js
index 9876543..fedcba9 100644
--- a/file2.js
+++ b/file2.js
@@ -1,3 +1,5 @@
+// New file header
 const utils = {
     helper: function() {
+        console.log('helper called');
         return 'help';
     }
@@ -8,6 +10,7 @@
     process: function(data) {
         return data.map(item => item.value);
     }
+    // Process comment
 };
 
 module.exports = utils;`;

/**
 * Test scenarios with expected results
 */
const testCases = [
    {
        name: 'Single hunk - first addition',
        file: 'file1.js',
        line: 2, // Line with "// New comment"
        expectedPosition: 2
    },
    {
        name: 'Single hunk - context line',
        file: 'file1.js', 
        line: 1, // Line with "function hello() {"
        expectedPosition: 1
    },
    {
        name: 'Single hunk - second addition',
        file: 'file1.js',
        line: 4, // Line with "console.log('world');"
        expectedPosition: 4
    },
    {
        name: 'Multi-hunk - second hunk addition',
        file: 'file1.js',
        line: 15, // Line with "// Another addition"
        expectedPosition: 11 // Correct position including subsequent @@ header
    },
    {
        name: 'Multi-hunk - context in second hunk',
        file: 'file1.js',
        line: 16, // Line with "function multiply(x, y) {"
        expectedPosition: 12 // Correct position including subsequent @@ header
    },
    {
        name: 'Second file - position resets',
        file: 'file2.js',
        line: 1, // Line with "// New file header"
        expectedPosition: 1 // Position should reset for new file
    },
    {
        name: 'Second file - addition in first hunk',
        file: 'file2.js',
        line: 4, // Line with "console.log('helper called');"
        expectedPosition: 4
    },
    {
        name: 'Second file - second hunk',
        file: 'file2.js',
        line: 13, // Line with "// Process comment"
        expectedPosition: 11 // Correct position including subsequent @@ header
    }
];

/**
 * Run position calculation tests
 */
function runPositionTests() {
    console.log('🧪 Testing GitHub Comment Position Tracking\n');
    console.log('='.repeat(60));
    
    let passed = 0;
    let failed = 0;
    const failures = [];
    
    testCases.forEach((testCase, index) => {
        console.log(`\nTest ${index + 1}: ${testCase.name}`);
        console.log(`File: ${testCase.file}, Line: ${testCase.line}`);
        
        const actualPosition = client.calculateDiffPosition(
            testDiff,
            testCase.file,
            testCase.line
        );
        
        console.log(`Expected: ${testCase.expectedPosition}, Got: ${actualPosition}`);
        
        if (actualPosition === testCase.expectedPosition) {
            console.log('✅ PASS');
            passed++;
        } else {
            console.log('❌ FAIL');
            failed++;
            failures.push({
                ...testCase,
                actualPosition,
                testIndex: index + 1
            });
        }
    });
    
    // Test edge cases
    console.log('\n' + '='.repeat(60));
    console.log('🔬 Testing Edge Cases\n');
    
    // Test missing file
    const missingFilePos = client.calculateDiffPosition(testDiff, 'nonexistent.js', 1);
    console.log(`Missing file test: Expected -1, Got: ${missingFilePos}`);
    if (missingFilePos === -1) {
        console.log('✅ PASS - Missing file handled correctly');
        passed++;
    } else {
        console.log('❌ FAIL - Missing file not handled correctly');
        failed++;
        failures.push({
            name: 'Missing file edge case',
            expectedPosition: -1,
            actualPosition: missingFilePos
        });
    }
    
    // Test line not in diff
    const missingLinePos = client.calculateDiffPosition(testDiff, 'file1.js', 999);
    console.log(`\nMissing line test: Expected -1, Got: ${missingLinePos}`);
    if (missingLinePos === -1) {
        console.log('✅ PASS - Missing line handled correctly');
        passed++;
    } else {
        console.log('❌ FAIL - Missing line not handled correctly');
        failed++;
        failures.push({
            name: 'Missing line edge case',
            expectedPosition: -1,
            actualPosition: missingLinePos
        });
    }
    
    // Test invalid parameters
    const invalidParams = client.calculateDiffPosition(null, 'file1.js', 1);
    console.log(`\nInvalid params test: Expected -1, Got: ${invalidParams}`);
    if (invalidParams === -1) {
        console.log('✅ PASS - Invalid parameters handled correctly');
        passed++;
    } else {
        console.log('❌ FAIL - Invalid parameters not handled correctly');
        failed++;
        failures.push({
            name: 'Invalid parameters edge case',
            expectedPosition: -1,
            actualPosition: invalidParams
        });
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${passed + failed}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
    
    if (failures.length > 0) {
        console.log('\n❌ FAILURES:');
        failures.forEach(failure => {
            console.log(`  - ${failure.name}: Expected ${failure.expectedPosition}, Got ${failure.actualPosition}`);
        });
    }
    
    return { passed, failed, failures };
}

/**
 * Analyze the diff to understand the position mapping
 */
function analyzeDiffStructure() {
    console.log('\n🔍 DIFF STRUCTURE ANALYSIS');
    console.log('='.repeat(60));
    
    const lines = testDiff.split('\n');
    let position = 0;
    let currentFile = '';
    let newLineNumber = 0;
    let inFile = false;
    let foundHunk = false;
    
    lines.forEach((line, index) => {
        if (line.startsWith('diff --git')) {
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
                currentFile = match[2];
                position = 0;
                newLineNumber = 0;
                foundHunk = false;
                console.log(`\n📁 FILE: ${currentFile}`);
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
                console.log(`  🎯 HUNK: ${line} (starting at new line ${newLineNumber + 1})`);
            }
            return;
        }
        
        if (foundHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
            position++;
            
            if (line.startsWith('+') || line.startsWith(' ')) {
                newLineNumber++;
                console.log(`    Pos ${position}: Line ${newLineNumber} | ${line.substring(0, 50)}${line.length > 50 ? '...' : ''}`);
            } else if (line.startsWith('-')) {
                console.log(`    Pos ${position}: DELETED | ${line.substring(0, 50)}${line.length > 50 ? '...' : ''}`);
            }
        }
    });
}

/**
 * Test frontend position tracking simulation
 */
function testFrontendPositionTracking() {
    console.log('\n🎨 FRONTEND POSITION TRACKING TEST');
    console.log('='.repeat(60));
    
    // Simulate the frontend logic from pr.js
    const mockFiles = [
        {
            newName: 'file1.js',
            blocks: [
                {
                    header: '@@ -1,4 +1,6 @@',
                    lines: [
                        { type: 'context', content: ' function hello() {', newNumber: 1 },
                        { type: 'add', content: '+    // New comment', newNumber: 2 },
                        { type: 'context', content: '     console.log(\'hello\');', newNumber: 3 },
                        { type: 'add', content: '+    console.log(\'world\');', newNumber: 4 },
                        { type: 'context', content: ' }', newNumber: 5 }
                    ]
                },
                {
                    header: '@@ -10,7 +12,8 @@',
                    lines: [
                        { type: 'context', content: '     return x + y;', newNumber: 13 },
                        { type: 'context', content: ' }', newNumber: 14 },
                        { type: 'add', content: '+// Another addition', newNumber: 15 },
                        { type: 'context', content: ' function multiply(x, y) {', newNumber: 16 }
                    ]
                }
            ]
        },
        {
            newName: 'file2.js',
            blocks: [
                {
                    header: '@@ -1,3 +1,5 @@',
                    lines: [
                        { type: 'add', content: '+// New file header', newNumber: 1 },
                        { type: 'context', content: ' const utils = {', newNumber: 2 }
                    ]
                }
            ]
        }
    ];
    
    // Simulate frontend position tracking
    mockFiles.forEach(file => {
        console.log(`\n📁 FILE: ${file.newName}`);
        let fileDiffPosition = 0;
        let foundFirstHunk = false;
        
        file.blocks.forEach((block, blockIndex) => {
            console.log(`  🎯 BLOCK ${blockIndex + 1}: ${block.header}`);
            
            // Reset position for first hunk only (matches frontend logic)
            if (!foundFirstHunk) {
                fileDiffPosition = 0;
                foundFirstHunk = true;
            }
            
            block.lines.forEach(line => {
                fileDiffPosition++;
                console.log(`    Frontend Pos ${fileDiffPosition}: Line ${line.newNumber || 'N/A'} | ${line.content}`);
            });
        });
    });
}

// Run all tests
if (require.main === module) {
    analyzeDiffStructure();
    
    const results = runPositionTests();
    
    testFrontendPositionTracking();
    
    // Exit with error code if tests failed
    if (results.failed > 0) {
        process.exit(1);
    }
    
    console.log('\n🎉 All tests passed!');
}

module.exports = { runPositionTests, analyzeDiffStructure };