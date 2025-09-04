#!/usr/bin/env node

/**
 * Analyze the specific failures in edge case tests
 */

const { GitHubClient } = require('./src/github/client');

const client = new GitHubClient('dummy-token');

// Analyze the whitespace failure
const whitespaceDiff = `diff --git a/whitespace.js b/whitespace.js
index 123..456 100644
--- a/whitespace.js
+++ b/whitespace.js
@@ -1,5 +1,5 @@
 function test() {
-    return true;  
+    return true;
 }
 
 module.exports = test;`;

console.log('ANALYZING WHITESPACE DIFF FAILURE');
console.log('='.repeat(50));
console.log('Diff content:');
console.log(whitespaceDiff);
console.log('\nLine-by-line analysis:');

const lines = whitespaceDiff.split('\n');
let position = 0;
let newLineNumber = 0;
let foundHunk = false;

lines.forEach((line, index) => {
    console.log(`${index}: "${line}"`);
    
    if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
        if (match) {
            newLineNumber = parseInt(match[1]) - 1;
            position = 0;
            foundHunk = true;
            console.log(`  → Hunk found, newLineNumber reset to ${newLineNumber}`);
        }
        return;
    }
    
    if (foundHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || (line === '' && foundHunk))) {
        position++;
        
        if (line.startsWith('+')) {
            newLineNumber++;
            console.log(`  → Pos ${position}: NEW Line ${newLineNumber} | ${line}`);
        } else if (line.startsWith('-')) {
            console.log(`  → Pos ${position}: DELETED | ${line}`);
        } else if (line.startsWith(' ')) {
            newLineNumber++;
            console.log(`  → Pos ${position}: CONTEXT Line ${newLineNumber} | ${line}`);
        } else if (line === '' && foundHunk) {
            newLineNumber++;
            console.log(`  → Pos ${position}: EMPTY CONTEXT Line ${newLineNumber}`);
        }
        
        if (newLineNumber === 2) {
            console.log(`  *** TARGET LINE 2 IS AT POSITION ${position} ***`);
        }
    }
});

const result = client.calculateDiffPosition(whitespaceDiff, 'whitespace.js', 2);
console.log(`\nCalculateDiffPosition result for line 2: ${result}`);

// Analyze the complex diff failure  
const complexDiff = `diff --git a/complex.js b/complex.js
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
 }`;

console.log('\n\nANALYZING COMPLEX DIFF FAILURE');
console.log('='.repeat(50));

const complexLines = complexDiff.split('\n');
position = 0;
newLineNumber = 0;
foundHunk = false;
let hunkCount = 0;

complexLines.forEach((line, index) => {
    if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
        if (match) {
            hunkCount++;
            newLineNumber = parseInt(match[1]) - 1;
            if (hunkCount === 1) {
                position = 0;
            }
            foundHunk = true;
            console.log(`\nHUNK ${hunkCount}: ${line}`);
            console.log(`  newLineNumber reset to ${newLineNumber}, position ${hunkCount === 1 ? 'reset to 0' : 'continues from ' + position}`);
        }
        return;
    }
    
    if (foundHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || (line === '' && foundHunk))) {
        position++;
        
        if (line.startsWith('+')) {
            newLineNumber++;
            console.log(`  Pos ${position}: NEW Line ${newLineNumber} | ${line.substring(0, 50)}...`);
            if (newLineNumber === 31) {
                console.log(`  *** TARGET LINE 31 IS AT POSITION ${position} ***`);
            }
        } else if (line.startsWith('-')) {
            console.log(`  Pos ${position}: DELETED | ${line.substring(0, 50)}...`);
        } else if (line.startsWith(' ') || (line === '' && foundHunk)) {
            newLineNumber++;
            console.log(`  Pos ${position}: CONTEXT Line ${newLineNumber} | ${line.substring(0, 50)}...`);
            if (newLineNumber === 31) {
                console.log(`  *** TARGET LINE 31 IS AT POSITION ${position} ***`);
            }
        }
    }
});

const complexResult = client.calculateDiffPosition(complexDiff, 'complex.js', 31);
console.log(`\nCalculateDiffPosition result for line 31: ${complexResult}`);