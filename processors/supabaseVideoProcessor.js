// processors/supabaseVideoProcessor.js
const { createClient } = require('@supabase/supabase-js');
const ytdl = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

class SupabaseVideoProcessor {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 3;
    
    // Initialize storage stats
    this.storage = {
      getStorageStats: () => this.getStorageStats()
    };
    
    this.ensureDirectories();
  }

  async ensureDirectories() {
    const dirs = [this.tempDir, this.outputDir];
    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        // Directory might already exist
      }
    }
  }

  async processVideo(videoUrl, options = {}) {
    const processingId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`Starting processing: ${processingId}`);
    
    try {
      // Step 1: Download video using fallback methods
      console.log('Downloading video...');
      const videoPath = await this.downloadVideoWithFallback(videoUrl, processingId);
      
      // Step 2: Process video to create short segments
      const processedVideo = await this.createOptimizedVideo(videoPath, processingId, options);
      
      // Step 3: Upload to Supabase storage
      const uploadResult = await this.uploadToSupabase(processedVideo, processingId);
      
      // Step 4: Cleanup temp files
      await this.cleanup(processingId);
      
      return uploadResult;
      
    } catch (error) {
      console.error(`Processing failed for ${processingId}:`, error.message);
      await this.cleanup(processingId);
      throw error;
    }
  }

  async downloadVideoWithFallback(videoUrl, processingId) {
    const methods = [
      () => this.downloadWithDistube(videoUrl, processingId),
      () => this.downloadWithYoutubeDl(videoUrl, processingId),
      () => this.downloadWithYtdlCore(videoUrl, processingId)
    ];

    let lastError;
    
    for (const method of methods) {
      try {
        return await method();
      } catch (error) {
        lastError = error;
        console.warn(`Download method failed: ${error.message}`);
        continue;
      }
    }
    
    throw new Error(`All download methods failed. Last error: ${lastError.message}`);
  }

  async downloadWithDistube(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    return new Promise((resolve, reject) => {
      try {
        const stream = ytdl(videoUrl, {
          quality: 'highest',
          filter: 'audioandvideo',
          requestOptions: {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          }
        });

        const writeStream = require('fs').createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        stream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve(outputPath));
        
      } catch (error) {
        reject(error);
      }
    });
  }

  async downloadWithYoutubeDl(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    
    try {
      const result = await youtubedl(videoUrl, {
        output: outputPath,
        format: 'best[height<=720]',
        mergeOutputFormat: 'mp4',
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        referer: videoUrl
      });
      
      // Find the actual output file
      const files = await fs.readdir(this.tempDir);
      const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
      
      if (!outputFile) {
        throw new Error('Downloaded file not found');
      }
      
      return path.join(this.tempDir, outputFile);
      
    } catch (error) {
      throw new Error(`youtube-dl-exec failed: ${error.message}`);
    }
  }

  async downloadWithYtdlCore(videoUrl, processingId) {
    // Fallback to original ytdl-core with error handling
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    return new Promise((resolve, reject) => {
      try {
        const stream = require('ytdl-core')(videoUrl, {
          quality: 'highest',
          filter: 'audioandvideo'
        });

        const writeStream = require('fs').createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        stream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve(outputPath));
        
      } catch (error) {
        reject(error);
      }
    });
  }

  async createOptimizedVideo(inputPath, processingId, options) {
    const { quality = 'medium', maxDuration = 300 } = options;
    const outputPath = path.join(this.outputDir, `${processingId}_processed.mp4`);
    
    return new Promise((resolve, reject) => {
      const resolution = quality === 'high' ? '1920x1080' : '1280x720';
      const bitrate = quality === 'high' ? '4000k' : '2000k';
      
      ffmpeg(inputPath)
        .duration(Math.min(maxDuration, 300)) // Max 5 minutes for free tier
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(resolution)
        .videoBitrate(bitrate)
        .audioBitrate('128k')
        .format('mp4')
        .outputOptions([
          '-preset fast',
          '-crf 23',
          '-movflags +faststart',
          '-pix_fmt yuv420p'
        ])
        .on('start', (cmd) => {
          console.log(`FFmpeg started: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Processing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', async () => {
          try {
            const stats = await fs.stat(outputPath);
            const thumbnail = await this.generateThumbnail(outputPath, processingId);
            
            resolve({
              videoPath: outputPath,
              thumbnailPath: thumbnail,
              fileSize: Math.round(stats.size / 1024 / 1024 * 100) / 100, // MB
              quality
            });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          reject(new Error(`Video processing failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async generateThumbnail(videoPath, processingId) {
    const thumbnailPath = path.join(this.outputDir, `${processingId}_thumb.jpg`);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(5)
        .frames(1)
        .size('640x360')
        .format('image2')
        .outputOptions(['-q:v 2'])
        .on('end', () => resolve(thumbnailPath))
        .on('error', (error) => {
          console.warn(`Thumbnail generation failed: ${error.message}`);
          resolve(null); // Don't fail the entire process for thumbnail
        })
        .save(thumbnailPath);
    });
  }

  async uploadToSupabase(processedData, processingId) {
    const { videoPath, thumbnailPath, fileSize, quality } = processedData;
    
    try {
      // Upload video
      const videoBuffer = await fs.readFile(videoPath);
      const videoKey = `processed-videos/${processingId}.mp4`;
      
      const { error: videoError } = await this.supabase.storage
        .from('temp-processing')
        .upload(videoKey, videoBuffer, {
          contentType: 'video/mp4',
          cacheControl: '3600',
          upsert: true
        });

      if (videoError) {
        throw new Error(`Video upload failed: ${videoError.message}`);
      }

      // Get video public URL
      const { data: { publicUrl: videoUrl } } = this.supabase.storage
        .from('temp-processing')
        .getPublicUrl(videoKey);

      let thumbnailUrl = null;
      
      // Upload thumbnail if available
      if (thumbnailPath) {
        try {
          const thumbnailBuffer = await fs.readFile(thumbnailPath);
          const thumbnailKey = `video-thumbnails/${processingId}.jpg`;
          
          const { error: thumbError } = await this.supabase.storage
            .from('temp-processing')
            .upload(thumbnailKey, thumbnailBuffer, {
              contentType: 'image/jpeg',
              cacheControl: '3600',
              upsert: true
            });

          if (!thumbError) {
            const { data: { publicUrl } } = this.supabase.storage
              .from('temp-processing')
              .getPublicUrl(thumbnailKey);
            thumbnailUrl = publicUrl;
          }
        } catch (thumbError) {
          console.warn('Thumbnail upload failed:', thumbError.message);
        }
      }

      return {
        videoUrl,
        thumbnailUrl,
        fileSize,
        quality,
        processingId
      };

    } catch (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }
  }

  async getStorageStats() {
    const buckets = ['temp-processing', 'processed-videos', 'video-thumbnails'];
    const stats = {};
    
    for (const bucket of buckets) {
      try {
        const { data, error } = await this.supabase.storage
          .from(bucket)
          .list('', { limit: 1000 });
        
        if (!error && data) {
          const totalSize = data.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
          stats[bucket] = {
            fileCount: data.length,
            totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100
          };
        } else {
          stats[bucket] = { fileCount: 0, totalSizeMB: 0 };
        }
      } catch (error) {
        stats[bucket] = { error: error.message };
      }
    }
    
    return stats;
  }

  async performMaintenance() {
    console.log('Performing storage maintenance...');
    
    try {
      // Clean up files older than 24 hours in temp-processing bucket
      const { data: files } = await this.supabase.storage
        .from('temp-processing')
        .list('', { limit: 1000 });
      
      if (files) {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const filesToDelete = files.filter(file => 
          new Date(file.created_at) < oneDayAgo
        ).map(file => file.name);
        
        if (filesToDelete.length > 0) {
          await this.supabase.storage
            .from('temp-processing')
            .remove(filesToDelete);
          
          console.log(`Cleaned up ${filesToDelete.length} old files`);
        }
      }
      
      // Get updated stats
      const stats = await this.getStorageStats();
      console.log('Storage stats:', stats);
      
    } catch (error) {
      console.error('Maintenance error:', error.message);
    }
  }

  async cleanup(processingId) {
    try {
      const directories = [this.tempDir, this.outputDir];
      let cleanedFiles = 0;

      for (const dir of directories) {
        try {
          const files = await fs.readdir(dir);
          const tempFiles = files.filter(file => file.includes(processingId));

          for (const file of tempFiles) {
            try {
              await fs.unlink(path.join(dir, file));
              cleanedFiles++;
            } catch (unlinkError) {
              // File might already be deleted
            }
          }
        } catch (readError) {
          // Directory might not exist
        }
      }

      if (cleanedFiles > 0) {
        console.log(`Cleaned up ${cleanedFiles} temp files for ${processingId}`);
      }
    } catch (error) {
      console.error(`Cleanup error for ${processingId}:`, error.message);
    }
  }
}

module.exports = SupabaseVideoProcessor;