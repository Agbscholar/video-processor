const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');
const SupabaseStorage = require('../utils/supabaseStorage');

class SupabaseVideoProcessor {
  constructor() {
    this.storage = new SupabaseStorage();
    this.maxFileSizeMB = 45; // Leave 5MB buffer from 50MB limit
  }

  async processVideo(videoUrl, options = {}) {
    const processingId = `proc_${Date.now()}`;
    let tempVideoPath = null;
    
    try {
      console.log(`Starting processing: ${processingId}`);
      
      // Step 1: Download video to memory
      const videoBuffer = await this.downloadVideoToBuffer(videoUrl);
      
      // Step 2: Upload to temp storage
      const tempFilename = `${processingId}_input.mp4`;
      tempVideoPath = await this.storage.uploadTempFile(videoBuffer, tempFilename);
      
      // Step 3: Get signed URL for processing
      const tempUrl = await this.storage.getTempFileUrl(tempVideoPath);
      
      // Step 4: Process video using URL
      const processedBuffer = await this.processWithFFmpeg(tempUrl, options);
      
      // Step 5: Upload processed video
      const processedFilename = `${processingId}_processed.mp4`;
      const processedResult = await this.storage.uploadProcessedVideo(
        processedBuffer, 
        processedFilename
      );
      
      // Step 6: Generate thumbnail
      const thumbnailBuffer = await this.generateThumbnail(tempUrl);
      const thumbnailFilename = `${processingId}_thumb.jpg`;
      const thumbnailResult = await this.storage.uploadThumbnail(
        thumbnailBuffer,
        thumbnailFilename
      );
      
      // Step 7: Cleanup temp file
      await this.cleanupTempFile(tempVideoPath);
      
      return {
        processingId,
        videoUrl: processedResult.publicUrl,
        thumbnailUrl: thumbnailResult.publicUrl,
        fileSize: Math.round(processedBuffer.length / (1024 * 1024) * 100) / 100
      };
      
    } catch (error) {
      // Cleanup on error
      if (tempVideoPath) {
        await this.cleanupTempFile(tempVideoPath);
      }
      throw error;
    }
  }

  async downloadVideoToBuffer(videoUrl) {
    try {
      console.log('Downloading video...');
      
      // For YouTube videos
      if (ytdl.validateURL(videoUrl)) {
        return new Promise((resolve, reject) => {
          const chunks = [];
          let totalSize = 0;
          const maxBytes = this.maxFileSizeMB * 1024 * 1024;
          
          const stream = ytdl(videoUrl, { 
            quality: 'lowest',
            filter: format => format.container === 'mp4'
          });
          
          stream.on('data', chunk => {
            totalSize += chunk.length;
            if (totalSize > maxBytes) {
              stream.destroy();
              reject(new Error(`Video too large: ${Math.round(totalSize/1024/1024)}MB > ${this.maxFileSizeMB}MB`));
              return;
            }
            chunks.push(chunk);
          });
          
          stream.on('end', () => {
            console.log(`Downloaded: ${Math.round(totalSize/1024/1024)}MB`);
            resolve(Buffer.concat(chunks));
          });
          
          stream.on('error', reject);
        });
      } 
      
      // For direct video URLs
      else {
        const response = await fetch(videoUrl);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > this.maxFileSizeMB * 1024 * 1024) {
          throw new Error(`Video too large: ${Math.round(contentLength/1024/1024)}MB > ${this.maxFileSizeMB}MB`);
        }
        
        const buffer = await response.buffer();
        console.log(`Downloaded: ${Math.round(buffer.length/1024/1024)}MB`);
        return buffer;
      }
    } catch (error) {
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  async processWithFFmpeg(inputUrl, options) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      console.log('Processing video with FFmpeg...');
      
      ffmpeg(inputUrl)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size('720x?')
        .videoBitrate('800k')
        .audioBitrate('128k')
        .format('mp4')
        .outputOptions([
          '-movflags faststart',
          '-preset fast'
        ])
        .on('start', (cmd) => {
          console.log('FFmpeg started:', cmd.split(' ').slice(-5).join(' '));
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Processing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          const buffer = Buffer.concat(chunks);
          console.log(`Processing complete: ${Math.round(buffer.length/1024/1024)}MB`);
          resolve(buffer);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .pipe()
        .on('data', (chunk) => {
          chunks.push(chunk);
        });
    });
  }

  async generateThumbnail(inputUrl) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      ffmpeg(inputUrl)
        .screenshots({
          count: 1,
          folder: '/tmp',
          filename: 'temp-thumb.jpg',
          size: '320x240'
        })
        .on('end', () => {
          // Read the generated thumbnail
          const fs = require('fs');
          const thumbPath = '/tmp/temp-thumb.jpg';
          if (fs.existsSync(thumbPath)) {
            const buffer = fs.readFileSync(thumbPath);
            fs.unlinkSync(thumbPath); // Clean up
            resolve(buffer);
          } else {
            reject(new Error('Thumbnail generation failed'));
          }
        })
        .on('error', reject);
    });
  }

  async cleanupTempFile(path) {
    try {
      await this.storage.supabase.storage
        .from('temp-processing')
        .remove([path]);
      console.log('Cleaned up temp file:', path);
    } catch (error) {
      console.error('Cleanup error:', error.message);
    }
  }

  // Regular cleanup of old temp files
  async performMaintenance() {
    console.log('Performing storage maintenance...');
    await this.storage.cleanupTempFiles(30); // Clean files older than 30 minutes
    
    const stats = await this.storage.getStorageStats();
    console.log('Storage stats:', stats);
  }
}

module.exports = SupabaseVideoProcessor;