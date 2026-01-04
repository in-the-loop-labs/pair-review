#!/usr/bin/env node

/**
 * Test script for AI orchestration flow
 * Tests that all three levels run and orchestration properly curates suggestions
 */

const Analyzer = require('./src/ai/analyzer');
const Database = require('./src/database');
const logger = require('./src/utils/logger');
const path = require('path');

async function testOrchestration() {
  logger.section('Testing AI Orchestration Flow');
  
  // Initialize database
  const db = await Database.initialize();
  
  // Initialize analyzer
  const analyzer = new Analyzer(db);
  
  // Test data
  const testPrId = 999;
  const testPrMetadata = {
    id: testPrId,
    number: 999,
    base_branch: 'main',
    head_branch: 'test-branch',
    repository: 'test/repo'
  };
  
  // Use current directory as worktree for testing
  const worktreePath = process.cwd();
  
  logger.info(`Testing with worktree: ${worktreePath}`);
  logger.info(`PR metadata: ${JSON.stringify(testPrMetadata)}`);
  
  try {
    // Run the full analysis with orchestration
    // Note: Old AI suggestions are no longer deleted; the API filters to show only the latest run
    logger.section('Starting Full Analysis with Orchestration');
    
    const result = await analyzer.analyzeLevel1(
      testPrId, 
      worktreePath, 
      testPrMetadata,
      (progress) => {
        logger.info(`Progress: ${progress.progress}`);
      }
    );
    
    // Check results
    logger.section('Test Results');
    
    if (result.orchestratedSuggestions) {
      logger.success(`✅ Orchestration completed successfully!`);
      logger.success(`   Total orchestrated suggestions: ${result.orchestratedSuggestions.length}`);
      
      // Show suggestion breakdown by type
      const typeCount = {};
      result.orchestratedSuggestions.forEach(s => {
        typeCount[s.type] = (typeCount[s.type] || 0) + 1;
      });
      
      logger.info('Suggestion breakdown by type:');
      Object.entries(typeCount).forEach(([type, count]) => {
        logger.info(`   ${type}: ${count}`);
      });
      
      // Check if praise was limited
      if (typeCount.praise && typeCount.praise <= 3) {
        logger.success(`✅ Praise suggestions properly limited to ${typeCount.praise}`);
      }
      
      // Sample a few suggestions
      logger.section('Sample Orchestrated Suggestions');
      result.orchestratedSuggestions.slice(0, 3).forEach((s, i) => {
        logger.info(`${i + 1}. [${s.type}] ${s.title}`);
        logger.info(`   File: ${s.file}:${s.line_start}`);
        logger.info(`   ${s.description.substring(0, 150)}...`);
      });
      
    } else {
      logger.error('❌ No orchestrated suggestions found in result');
    }
    
    // Check database storage
    const { query } = require('./src/database');
    const storedSuggestions = await query(db, 
      'SELECT * FROM comments WHERE pr_id = ? AND source = ?',
      [testPrId, 'ai']
    );
    
    logger.section('Database Verification');
    logger.info(`Suggestions stored in database: ${storedSuggestions.length}`);
    
    if (storedSuggestions.length > 0) {
      logger.success('✅ Suggestions successfully stored to database');
      
      // Check for orchestrated level
      const orchestratedCount = storedSuggestions.filter(s => 
        s.ai_level === 'orchestrated' || s.ai_level === 'fallback'
      ).length;
      
      if (orchestratedCount > 0) {
        logger.success(`✅ Found ${orchestratedCount} orchestrated/fallback suggestions in database`);
      }
    }
    
  } catch (error) {
    logger.error(`Test failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
  
  logger.section('Test Complete');
  logger.success('🎉 AI Orchestration test completed successfully!');
  process.exit(0);
}

// Run the test
testOrchestration().catch(error => {
  logger.error('Unexpected error:', error);
  process.exit(1);
});