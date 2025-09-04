#!/usr/bin/env node

/**
 * Integration test for frontend-backend position consistency
 * Verifies that frontend fileDiffPosition matches backend calculateDiffPosition
 */

const { GitHubClient } = require('./src/github/client');

// Create test instance
const client = new GitHubClient('dummy-token');

// Complex test diff that should match real-world scenarios
const integrationTestDiff = `diff --git a/src/components/Header.js b/src/components/Header.js
index 123..456 100644
--- a/src/components/Header.js
+++ b/src/components/Header.js
@@ -1,8 +1,10 @@
 import React from 'react';
+import { useAuth } from '../hooks/useAuth';
 
 function Header() {
+    const { user } = useAuth();
     return (
         <header>
+            <span>Welcome {user?.name}</span>
             <h1>My App</h1>
         </header>
     );
@@ -15,6 +17,7 @@
 }
 
 Header.displayName = 'Header';
+Header.propTypes = {};
 
 export default Header;
diff --git a/src/utils/helpers.js b/src/utils/helpers.js
index 789..abc 100644
--- a/src/utils/helpers.js
+++ b/src/utils/helpers.js
@@ -1,4 +1,6 @@
+// Utility functions for the app
 export function formatDate(date) {
+    if (!date) return 'N/A';
     return new Intl.DateTimeFormat('en-US').format(date);
 }
 
@@ -8,6 +10,7 @@
     return str.split(' ').map(word => 
         word.charAt(0).toUpperCase() + word.slice(1)
     ).join(' ');
+    // TODO: Handle edge cases
 }`;

/**
 * Simulate frontend position tracking logic
 */
function simulateFrontendPositions(diffContent) {
    console.log('🎨 SIMULATING FRONTEND POSITION TRACKING');
    console.log('='.repeat(60));
    
    const lines = diffContent.split('\n');
    const frontendResults = [];
    let currentFile = null;
    let fileDiffPosition = 0;
    let foundFirstHunk = false;
    let newLineNumber = 0;
    let inBlock = false;
    
    lines.forEach(line => {
        // File header detection
        if (line.startsWith('diff --git')) {
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
                currentFile = match[2];
                fileDiffPosition = 0;
                foundFirstHunk = false;
                newLineNumber = 0;
                console.log(`\n📁 FILE: ${currentFile}`);
            }
            return;
        }
        
        // Hunk header detection
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
            if (match) {
                newLineNumber = parseInt(match[1]) - 1;
                inBlock = true;
                
                // Reset position for first hunk only (matches frontend pr.js logic)
                if (!foundFirstHunk) {
                    fileDiffPosition = 0;
                    foundFirstHunk = true;
                } else {
                    // Subsequent block headers (@@) count as positions according to GitHub spec
                    fileDiffPosition++;
                    console.log(`    Frontend: Counting subsequent @@ header as position ${fileDiffPosition}: ${line}`);
                }
                console.log(`  🎯 HUNK: ${line}`);
            }
            return;
        }
        
        // Skip non-content lines
        if (!inBlock || !currentFile) return;
        
        // Skip header lines within diff (---, +++, index)
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) return;
        
        // Process only actual diff content lines
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || (line === '' && inBlock)) {
            fileDiffPosition++; // Frontend increments for each diff line
            
            if (line.startsWith('+')) {
                newLineNumber++;
                console.log(`    Frontend Pos ${fileDiffPosition}: Line ${newLineNumber} | + ${line.substring(1)}`);
                frontendResults.push({
                    file: currentFile,
                    line: newLineNumber,
                    frontendPosition: fileDiffPosition
                });
            } else if (line.startsWith(' ') || (line === '' && inBlock)) {
                newLineNumber++;
                console.log(`    Frontend Pos ${fileDiffPosition}: Line ${newLineNumber} | ${line === '' ? '(empty context)' : line}`);
                frontendResults.push({
                    file: currentFile,
                    line: newLineNumber,
                    frontendPosition: fileDiffPosition
                });
            } else if (line.startsWith('-')) {
                console.log(`    Frontend Pos ${fileDiffPosition}: DELETED | - ${line.substring(1)}`);
            }
        }
    });
    
    return frontendResults;
}

/**
 * Test frontend-backend consistency
 */
function runIntegrationTest() {
    console.log('🔄 TESTING FRONTEND-BACKEND POSITION CONSISTENCY');
    console.log('='.repeat(60));
    
    const frontendResults = simulateFrontendPositions(integrationTestDiff);
    
    console.log('\n🔍 COMPARING FRONTEND VS BACKEND POSITIONS');
    console.log('='.repeat(60));
    
    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    const failures = [];
    
    frontendResults.forEach(result => {
        const backendPosition = client.calculateDiffPosition(
            integrationTestDiff,
            result.file,
            result.line
        );
        
        totalTests++;
        console.log(`\nFile: ${result.file}, Line: ${result.line}`);
        console.log(`Frontend Position: ${result.frontendPosition}`);
        console.log(`Backend Position: ${backendPosition}`);
        
        if (result.frontendPosition === backendPosition) {
            console.log('✅ CONSISTENT');
            passed++;
        } else {
            console.log('❌ MISMATCH!');
            failed++;
            failures.push({
                file: result.file,
                line: result.line,
                frontend: result.frontendPosition,
                backend: backendPosition
            });
        }
    });
    
    // Test some specific edge cases
    console.log('\n🔬 TESTING EDGE CASE CONSISTENCY');
    console.log('='.repeat(30));
    
    const edgeCases = [
        { file: 'src/components/Header.js', line: 2 }, // Import addition
        { file: 'src/components/Header.js', line: 5 }, // useAuth addition  
        { file: 'src/components/Header.js', line: 8 }, // Welcome span
        { file: 'src/components/Header.js', line: 20 }, // propTypes addition
        { file: 'src/utils/helpers.js', line: 1 }, // Comment addition
        { file: 'src/utils/helpers.js', line: 3 }, // Null check
        { file: 'src/utils/helpers.js', line: 13 } // TODO comment
    ];
    
    edgeCases.forEach(testCase => {
        const backendPos = client.calculateDiffPosition(integrationTestDiff, testCase.file, testCase.line);
        const frontendResult = frontendResults.find(r => r.file === testCase.file && r.line === testCase.line);
        
        if (frontendResult) {
            totalTests++;
            if (frontendResult.frontendPosition === backendPos) {
                console.log(`✅ ${testCase.file}:${testCase.line} - Positions match (${backendPos})`);
                passed++;
            } else {
                console.log(`❌ ${testCase.file}:${testCase.line} - Mismatch! Frontend: ${frontendResult.frontendPosition}, Backend: ${backendPos}`);
                failed++;
                failures.push({
                    file: testCase.file,
                    line: testCase.line,
                    frontend: frontendResult.frontendPosition,
                    backend: backendPos
                });
            }
        } else {
            console.log(`⚠️ ${testCase.file}:${testCase.line} - Not found in frontend results`);
        }
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 INTEGRATION TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Position Comparisons: ${totalTests}`);
    console.log(`✅ Consistent: ${passed}`);
    console.log(`❌ Mismatched: ${failed}`);
    console.log(`Consistency Rate: ${((passed / totalTests) * 100).toFixed(1)}%`);
    
    if (failures.length > 0) {
        console.log('\n❌ INCONSISTENCIES FOUND:');
        failures.forEach(failure => {
            console.log(`  ${failure.file}:${failure.line} - Frontend: ${failure.frontend}, Backend: ${failure.backend}`);
        });
    }
    
    return { totalTests, passed, failed, failures };
}

// Run the integration test
if (require.main === module) {
    const results = runIntegrationTest();
    
    if (results.failed > 0) {
        console.log('\n❌ Frontend-Backend position tracking is INCONSISTENT!');
        process.exit(1);
    } else {
        console.log('\n🎉 Frontend and Backend position tracking is FULLY CONSISTENT!');
    }
}

module.exports = { runIntegrationTest };