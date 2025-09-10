#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

/**
 * Cleanup script for removing old temporary files and processing artifacts
 */
class CleanupManager {
  constructor() {
    this.tempDirectories = [
      '/tmp/uploads',
      '/tmp/processing', 
      '/tmp/output',
      '/tmp/downloads',
      '/tmp/sliced',
      '/tmp/thumbnails'
    ];
  }

  async run(options = {}) {
    const {
      olderThanHours = 24,
      dryRun = false,
      verbose = true
    } = options;

    const cutoffTime = Date.now() - (olderThanHours * 60 * 60 * 1000);
    let totalDeleted = 0;
    let totalSizeMB = 0;

    console.log(`🧹 Starting cleanup process...`);
    console.log(`📅 Removing files older than ${olderThanHours} hours`);
    console.log(`🔍 Dry run: ${dryRun ? 'Yes' : 'No'}`);
    console.log('');

    for (const dir of this.tempDirectories) {
      try {
        const result = await this.cleanDirectory(dir, cutoffTime, dryRun, verbose);
        totalDeleted += result.filesDeleted;
        totalSizeMB += result.sizeMB;
        
        if (verbose && result.filesDeleted > 0) {
          console.log(`📁 ${dir}: ${result.filesDeleted} files (${result.sizeMB.toFixed(2)}MB)`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`❌ Error cleaning ${dir}:`, error.message);
        }
      }
    }

    console.log('');
    console.log(`✅ Cleanup complete!`);
    console.log(`📊 Total files ${dryRun ? 'would be' : ''} removed: ${totalDeleted}`);
    console.log(`💾 Total space ${dryRun ? 'would be' : ''} freed: ${totalSizeMB.toFixed(2)}MB`);

    if (dryRun) {
      console.log('');
      console.log('🔄 Run with --no-dry-run to actually delete files');
    }
  }

  async cleanDirectory(dirPath, cutoffTime, dryRun, verbose) {
    let filesDeleted = 0;
    let sizeMB = 0;

    try {
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        
        try {
          const stats = await fs.stat(filePath);
          
          if (stats.isFile() && stats.mtime.getTime() < cutoffTime) {
            const fileSizeMB = stats.size / 1024 / 1024;
            
            if (verbose) {
              const ageHours = Math.round((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60));
              console.log(`  🗑️  ${file} (${fileSizeMB.toFixed(2)}MB, ${ageHours}h old)`);
            }
            
            if (!dryRun) {
              await fs.unlink(filePath);
            }
            
            filesDeleted++;
            sizeMB += fileSizeMB;
          }
        } catch (fileError) {
          console.error(`    ⚠️  Could not process ${file}:`, fileError.message);
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (verbose) {
          console.log(`📁 ${dirPath}: Directory not found, skipping`);
        }
      } else {
        throw error;
      }
    }

    return { filesDeleted, sizeMB };
  }

  async ensureDirectories() {
    console.log('📁 Ensuring temporary directories exist...');
    
    for (const dir of this.tempDirectories) {
      try {
        await fs.mkdir(dir, { recursive: true });
        console.log(`  ✅ ${dir}`);
      } catch (error) {
        console.error(`  ❌ Failed to create ${dir}:`, error.message);
      }
    }
  }

  async getDirectoryStats() {
    console.log('📊 Directory statistics:');
    console.log('');

    for (const dir of this.tempDirectories) {
      try {
        const files = await fs.readdir(dir);
        let totalSize = 0;
        let fileCount = 0;

        for (const file of files) {
          try {
            const stats = await fs.stat(path.join(dir, file));
            if (stats.isFile()) {
              totalSize += stats.size;
              fileCount++;
            }
          } catch (error) {
            // Skip files that can't be accessed
          }
        }

        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`  📁 ${dir}: ${fileCount} files, ${sizeMB}MB`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`  📁 ${dir}: Directory not found`);
        } else {
          console.log(`  ❌ ${dir}: Error - ${error.message}`);
        }
      }
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const cleanup = new CleanupManager();

  // Parse arguments
  const options = {
    olderThanHours: 24,
    dryRun: true,
    verbose: true
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--hours':
        options.olderThanHours = parseInt(args[++i]) || 24;
        break;
      case '--no-dry-run':
        options.dryRun = false;
        break;
      case '--quiet':
        options.verbose = false;
        break;
      case '--stats':
        await cleanup.getDirectoryStats();
        return;
      case '--init':
        await cleanup.ensureDirectories();
        return;
      case '--help':
        console.log(`
Video Processing Cleanup Script

Usage: node cleanup.js [options]

Options:
  --hours <n>       Remove files older than N hours (default: 24)
  --no-dry-run     Actually delete files (default is dry run)
  --quiet          Minimal output
  --stats          Show directory statistics and exit
  --init           Create temporary directories and exit
  --help           Show this help

Examples:
  node cleanup.js                    # Dry run, remove files older than 24h
  node cleanup.js --hours 12         # Dry run, remove files older than 12h  
  node cleanup.js --no-dry-run       # Actually delete files older than 24h
  node cleanup.js --stats            # Show directory statistics
        `);
        return;
      default:
        console.error(`Unknown argument: ${arg}`);
        console.log('Use --help for usage information');
        process.exit(1);
    }
  }

  await cleanup.run(options);
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Cleanup script failed:', error);
    process.exit(1);
  });
}

module.exports = CleanupManager;