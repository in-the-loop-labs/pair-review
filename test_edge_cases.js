#!/usr/bin/env node

/**
 * Test edge cases for GitHub comment position tracking
 * Covers binary files, empty files, large files, and other edge scenarios
 */

const { GitHubClient } = require('./src/github/client');

// Create test instance
const client = new GitHubClient('dummy-token');

/**
 * Edge case test scenarios
 */
const edgeCaseTests = [
    {
        name: 'Binary file diff',
        diff: `diff --git a/image.png b/image.png
index 123..456 100644
Binary files a/image.png and b/image.png differ`,
        tests: [
            { file: 'image.png', line: 1, expected: -1, description: 'Binary file should return -1' }
        ]
    },
    
    {
        name: 'New file with only additions',
        diff: `diff --git a/newfile.js b/newfile.js
new file mode 100644
index 0000000..123456
--- /dev/null
+++ b/newfile.js
@@ -0,0 +1,5 @@
+console.log('new file');
+
+function test() {
+    return true;
+}`,
        tests: [
            { file: 'newfile.js', line: 1, expected: 1, description: 'First line of new file' },
            { file: 'newfile.js', line: 2, expected: 2, description: 'Empty line in new file' },
            { file: 'newfile.js', line: 3, expected: 3, description: 'Function start in new file' }
        ]
    },
    
    {
        name: 'Deleted file',
        diff: `diff --git a/oldfile.js b/oldfile.js
deleted file mode 100644
index 123456..0000000
--- a/oldfile.js
+++ /dev/null
@@ -1,3 +0,0 @@
-console.log('old file');
-// This will be deleted
-module.exports = {};`,
        tests: [
            { file: 'oldfile.js', line: 1, expected: -1, description: 'Deleted file should return -1' }
        ]
    },
    
    {
        name: 'File with only whitespace changes',
        diff: `diff --git a/whitespace.js b/whitespace.js
index 123..456 100644
--- a/whitespace.js
+++ b/whitespace.js
@@ -1,5 +1,5 @@
 function test() {
-    return true;  
+    return true;
 }
 
 module.exports = test;`,
        tests: [
            { file: 'whitespace.js', line: 1, expected: 1, description: 'Context line should work' },
            { file: 'whitespace.js', line: 2, expected: 3, description: 'Modified whitespace line (pos 3: deleted at 2, addition at 3)' }
        ]
    },
    
    {
        name: 'File with complex hunk structure',
        diff: `diff --git a/complex.js b/complex.js
index 123..456 100644
--- a/complex.js
+++ b/complex.js
@@ -1,3 +1,4 @@
 // Header comment
+const VERSION = '1.0';
 
 function main() {
@@ -10,8 +11,10 @@
     // Process data
     const result = process(data);
 
+    // Log the result
     console.log(result);
+    console.log('Processing complete');
 
     return result;
 }
@@ -25,6 +28,7 @@
 }
 
 function process(data) {
+    console.log('Processing:', data);
     return data.map(item => item.value);
 }`,
        tests: [
            { file: 'complex.js', line: 2, expected: 2, description: 'First addition' },
            { file: 'complex.js', line: 14, expected: 8, description: 'Second hunk first addition' },
            { file: 'complex.js', line: 16, expected: 10, description: 'Second hunk second addition' },
            { file: 'complex.js', line: 31, expected: 17, description: 'Third hunk addition (position continues across hunks)' }
        ]
    },
    
    {
        name: 'Empty file changes',
        diff: `diff --git a/empty.txt b/empty.txt
index e69de29..5d308e1 100644
--- a/empty.txt
+++ b/empty.txt
@@ -0,0 +1,2 @@
+First line
+Second line`,
        tests: [
            { file: 'empty.txt', line: 1, expected: 1, description: 'First line in previously empty file' },
            { file: 'empty.txt', line: 2, expected: 2, description: 'Second line in previously empty file' }
        ]
    }
];

/**
 * Run edge case tests
 */
function runEdgeCaseTests() {
    console.log('🔬 TESTING EDGE CASES FOR POSITION TRACKING');
    console.log('='.repeat(60));
    
    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    const failures = [];
    
    edgeCaseTests.forEach(edgeCase => {
        console.log(`\n📋 ${edgeCase.name}`);
        console.log('-'.repeat(40));
        
        edgeCase.tests.forEach(test => {
            totalTests++;
            const actualPosition = client.calculateDiffPosition(
                edgeCase.diff,
                test.file,
                test.line
            );
            
            console.log(`  ${test.description}`);
            console.log(`  File: ${test.file}, Line: ${test.line}`);
            console.log(`  Expected: ${test.expected}, Got: ${actualPosition}`);
            
            if (actualPosition === test.expected) {
                console.log('  ✅ PASS\n');
                passed++;
            } else {
                console.log('  ❌ FAIL\n');
                failed++;
                failures.push({
                    scenario: edgeCase.name,
                    description: test.description,
                    file: test.file,
                    line: test.line,
                    expected: test.expected,
                    actual: actualPosition
                });
            }
        });
    });
    
    console.log('='.repeat(60));
    console.log('📊 EDGE CASE TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${totalTests}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`Success Rate: ${((passed / totalTests) * 100).toFixed(1)}%`);
    
    if (failures.length > 0) {
        console.log('\n❌ EDGE CASE FAILURES:');
        failures.forEach(failure => {
            console.log(`  ${failure.scenario} - ${failure.description}`);
            console.log(`    ${failure.file}:${failure.line} - Expected: ${failure.expected}, Got: ${failure.actual}`);
        });
    }
    
    return { totalTests, passed, failed, failures };
}

/**
 * Test parameter validation
 */
function runParameterValidationTests() {
    console.log('\n🛡️ TESTING PARAMETER VALIDATION');
    console.log('='.repeat(60));
    
    const validationTests = [
        {
            name: 'Null diff content',
            diff: null,
            file: 'test.js',
            line: 1,
            expected: -1
        },
        {
            name: 'Empty diff content',
            diff: '',
            file: 'test.js', 
            line: 1,
            expected: -1
        },
        {
            name: 'Null file path',
            diff: 'diff --git a/test.js b/test.js\n@@ -1 +1,2 @@\n line\n+addition',
            file: null,
            line: 2,
            expected: -1
        },
        {
            name: 'Undefined line number',
            diff: 'diff --git a/test.js b/test.js\n@@ -1 +1,2 @@\n line\n+addition',
            file: 'test.js',
            line: undefined,
            expected: -1
        },
        {
            name: 'Negative line number',
            diff: 'diff --git a/test.js b/test.js\n@@ -1 +1,2 @@\n line\n+addition',
            file: 'test.js',
            line: -1,
            expected: -1
        }
    ];
    
    let validationPassed = 0;
    let validationFailed = 0;
    
    validationTests.forEach(test => {
        console.log(`\n${test.name}:`);
        const result = client.calculateDiffPosition(test.diff, test.file, test.line);
        console.log(`Expected: ${test.expected}, Got: ${result}`);
        
        if (result === test.expected) {
            console.log('✅ PASS');
            validationPassed++;
        } else {
            console.log('❌ FAIL');
            validationFailed++;
        }
    });
    
    console.log(`\nValidation Tests: ${validationPassed}/${validationPassed + validationFailed} passed`);
    return { validationPassed, validationFailed };
}

// Run all edge case tests
if (require.main === module) {
    const results = runEdgeCaseTests();
    const validationResults = runParameterValidationTests();
    
    const totalTests = results.totalTests + validationResults.validationPassed + validationResults.validationFailed;
    const totalPassed = results.passed + validationResults.validationPassed;
    const totalFailed = results.failed + validationResults.validationFailed;
    
    console.log('\n' + '='.repeat(60));
    console.log('🎯 OVERALL EDGE CASE SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Tests Run: ${totalTests}`);
    console.log(`✅ Passed: ${totalPassed}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`Overall Success Rate: ${((totalPassed / totalTests) * 100).toFixed(1)}%`);
    
    if (totalFailed > 0) {
        console.log('\n❌ Some edge case tests failed!');
        process.exit(1);
    } else {
        console.log('\n🎉 All edge case tests passed!');
    }
}

module.exports = { runEdgeCaseTests, runParameterValidationTests };