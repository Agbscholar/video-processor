const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

/**
 * Base processor class for handling generic video processing
 * This handles videos that aren't from specific platforms like YouTube or TikTok
 */
class BaseProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxFileSize = 500 * 1024 * 1024; // 500MB
    this.maxDuration = 1800; // 30 minutes
  }

  async process(data) {
    const { 
      processing_id, 
      video_url, 
      video_path,
      video_info, 
      subscription_type, 
      supabase_config,
      user_limits = { max_shorts: 3 }
    } = data;
    
    console.log(`[${processing_id}] Starting base video processing`);
    
    // Initialize Supabase client
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    
    try {
      // 1. Get or download video file
      if (video_path && await this.fileExists(video_path)) {
        originalVideoPath = video_path;
        console.log(`[${processing_id}] Using uploaded video file`);
      } else if (video_url) {
        console.log(`[${processing_id}] Downloading video from URL`);
        originalVideoPath = await this.downloadVideo(video_url, processing_id);
      } else {
        throw new Error('No video URL or file path provided');
      }
      
      // 2. Get video metadata and validate
      console.log(`[${processing_id}] Analyzing video file`);
      const metadata = await this.getVideoMetadata(originalVideoPath);
      this.validateVideo(metadata, subscription_type);
      
      // 3. Create enhanced video info if not provided
      const enhancedVideoInfo = await this.enhanceVideoInfo(video_info, metadata, originalVideoPath);
      
      // 4. Create shorts segments
      console.log(`[${processing_id}] Creating video shorts`);
      const shorts = await this.createShorts(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        video_info: enhancedVideoInfo
      });
      
      // 5. Generate thumbnails
      console.log(`[${processing_id}] Generating thumbnails`);
      const shortsWithThumbnails = await this.generateThumbnails(shorts, processing_id);
      
      // 6. Upload to storage
      console.log(`[${processing_id}] Uploading to cloud storage`);
      const uploadedShorts = await this.uploadToStorage(shortsWithThumbnails, supabase, processing_id);
      
      // 7. Save to database
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: enhancedVideoInfo,
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      // 8. Cleanup
      await this.cleanup(processing_id);
      
      console.log(`[${processing_id}] Base processing completed successfully`);
      
      return {
        processing_id,
        shorts_results: uploadedShorts,
        total_shorts: uploadedShorts.length,
        video_info: enhancedVideoInfo,
        platform: enhancedVideoInfo.platform || 'Other',
        subscription_type,
        processing_completed_at: new Date().toISOString(),
        usage_stats: {
          original_duration: metadata.duration,
          original_size_mb: metadata.size_mb,
          processing_time: `${Math.round(metadata.processing_time / 1000)} seconds`,
          shorts_total_duration: uploadedShorts.reduce((sum, short) => sum + (short.duration || 60), 0)
        }
      };
      
    } catch (error) {
      console.error(`[${processing_id}] Base processing failed:`, error);
      
      // Cleanup on error
      if (originalVideoPath && video_url) { // Only cleanup downloaded files, not uploaded ones
        await this.cleanup(processing_id);
      }
      
      throw this.enhanceError(error, processing_id);
    }
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async downloadVideo(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    try {
      console.log(`[${processingId}] Starting download from: ${videoUrl}`);
      
      const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        timeout: 300000, // 5 minutes
        maxContentLength: this.maxFileSize,
        headers: {
          'User-Agent': 'VideoProcessingBot/1.0'
        }
      });
      
      // Check content type
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('video/')) {
        throw new Error(`Invalid content type: ${contentType}. Expected video file.`);
      }
      
      // Check file size
      const contentLength = parseInt(response.headers['content-length']);
      if (contentLength && contentLength > this.maxFileSize) {
        throw new Error(`File too large: ${Math.round(contentLength / 1024 / 1024)}MB. Max allowed: ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
      }
      
      // Download the file
      const writer = require('fs').createWriteStream(outputPath);
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`[${processingId}] Download completed: ${outputPath}`);
          resolve(outputPath);
        });
        
        writer.on('error', (error) => {
          console.error(`[${processingId}] Download write error:`, error);
          reject(new Error(`Failed to save downloaded file: ${error.message}`));
        });
        
        response.data.on('error', (error) => {
          console.error(`[${processingId}] Download stream error:`, error);
          reject(new Error(`Download failed: ${error.message}`));
        });
      });
      
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Download timeout - file might be too large or connection is slow');
      } else if (error.response) {
        throw new Error(`Download failed with status ${error.response.status}: ${error.response.statusText}`);
      } else {
        throw new Error(`Download failed: ${error.message}`);
      }
    }
  }

  async getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to read video metadata: ${err.message}`));
          return;
        }
        
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
        const format = metadata.format;
        
        if (!videoStream) {
          reject(new Error('No video stream found - file may be corrupted or invalid'));
          return;
        }
        
        resolve({
          duration: parseFloat(format.duration) || 0,
          size_bytes: parseInt(format.size) || 0,
          size_mb: Math.round((parseInt(format.size) || 0) / 1024 / 1024 * 100) / 100,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          fps: this.parseFrameRate(videoStream.r_frame_rate) || 30,
          bitrate: parseInt(format.bit_rate) || 0,
          codec: videoStream.codec_name,
          format: format.format_name,
          has_audio: !!audioStream,
          audio_codec: audioStream?.codec_name,
          processing_time: Date.now()
        });
      });
    });
  }

  parseFrameRate(frameRateString) {
    if (!frameRateString) return 30;
    
    try {
      if (frameRateString.includes('/')) {
        const [num, den] = frameRateString.split('/');
        return parseFloat(num) / parseFloat(den);
      }
      return parseFloat(frameRateString);
    } catch {
      return 30; // Default fallback
    }
  }

  validateVideo(metadata, subscriptionType) {
    // Duration check
    const maxDuration = subscriptionType === 'free' ? 600 : this.maxDuration; // 10 min free, 30 min premium
    if (metadata.duration > maxDuration) {
      throw new Error(`Video too long: ${Math.round(metadata.duration / 60)}min. Max: ${Math.round(maxDuration / 60)}min for ${subscriptionType} users`);
    }
    
    if (metadata.duration < 60) {
      throw new Error('Video too short: minimum 60 seconds required for shorts creation');
    }
    
    // Size check
    const maxSizeMB = subscriptionType === 'free' ? 100 : 500;
    if (metadata.size_mb > maxSizeMB) {
      throw new Error(`File too large: ${metadata.size_mb}MB. Max: ${maxSizeMB}MB for ${subscriptionType} users`);
    }
    
    // Resolution check
    if (metadata.width < 480 || metadata.height < 360) {
      throw new Error(`Resolution too low: ${metadata.width}x${metadata.height}. Minimum: 480x360`);
    }
    
    // Audio check (warn but don't fail)
    if (!metadata.has_audio) {
      console.warn(`[WARNING] Video has no audio track - shorts may be less engaging`);
    }
    
    console.log(`Video validation passed - ${metadata.duration}s, ${metadata.size_mb}MB, ${metadata.width}x${metadata.height}`);
  }

  async enhanceVideoInfo(videoInfo, metadata, videoPath) {
    // Create enhanced video info with metadata
    const enhanced = {
      title: videoInfo?.title || this.generateTitleFromPath(videoPath),
      description: videoInfo?.description || 'Video processed by VideoShortsBot',
      platform: videoInfo?.platform || 'Upload',
      duration: Math.round(metadata.duration),
      width: metadata.width,
      height: metadata.height,
      size_mb: metadata.size_mb,
      format: metadata.format,
      codec: metadata.codec,
      fps: Math.round(metadata.fps),
      has_audio: metadata.has_audio,
      created_at: new Date().toISOString(),
      ...videoInfo // Override with any provided info
    };
    
    // Generate thumbnail from video if not provided
    if (!enhanced.thumbnail) {
      try {
        enhanced.thumbnail = await this.generatePreviewThumbnail(videoPath);
      } catch (error) {
        console.warn('Failed to generate preview thumbnail:', error);
        enhanced.thumbnail = null;
      }
    }
    
    return enhanced;
  }

  generateTitleFromPath(videoPath) {
    const filename = path.basename(videoPath, path.extname(videoPath));
    // Clean up filename - remove processing ID and make readable
    return filename
      .replace(/^proc_\w+_\d+_/, '') // Remove processing prefix
      .replace(/[_-]/g, ' ') // Replace underscores/dashes with spaces
      .replace(/\b\w/g, l => l.toUpperCase()) // Capitalize words
      .substring(0, 100); // Limit length
  }

  async generatePreviewThumbnail(videoPath) {
    const thumbnailPath = path.join(this.tempDir, `preview_${Date.now()}.jpg`);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(10) // Extract at 10 seconds
        .frames(1)
        .size('640x360')
        .format('image2')
        .outputOptions(['-q:v 2'])
        .on('end', async () => {
          try {
            // Convert to base64 for easy transmission
            const buffer = await fs.readFile(thumbnailPath);
            const base64 = buffer.toString('base64');
            await fs.unlink(thumbnailPath); // Cleanup
            resolve(`data:image/jpeg;base64,${base64}`);
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject)
        .save(thumbnailPath);
    });
  }

  async createShorts(originalVideoPath, options) {
    const { processing_id, subscription_type, user_limits, video_duration } = options;
    
    // Calculate shorts parameters
    const maxShorts = subscription_type === 'free' ? 
      Math.min(user_limits.max_shorts || 2, 3) : 
      Math.min(user_limits.max_shorts || 5, 8);
    
    const segmentDuration = 60; // 60 seconds per short
    const possibleShorts = Math.floor(video_duration / segmentDuration);
    const numShorts = Math.min(maxShorts, possibleShorts);
    
    if (numShorts === 0) {
      throw new Error('Video too short for shorts creation (minimum 60 seconds required)');
    }
    
    console.log(`[${processing_id}] Creating ${numShorts} shorts from ${Math.round(video_duration)}s video`);
    
    const shorts = [];
    
    // Smart segment selection - avoid very beginning and end
    const usableStart = Math.min(30, video_duration * 0.1); // Skip first 30s or 10%
    const usableEnd = video_duration - Math.min(30, video_duration * 0.1); // Skip last 30s or 10%
    const usableDuration = usableEnd - usableStart;
    
    if (usableDuration < segmentDuration) {
      // Fallback to simple segmentation
      const interval = Math.max(segmentDuration, video_duration / numShorts);
      
      for (let i = 0; i < numShorts; i++) {
        const startTime = Math.floor(i * interval);
        const actualDuration = Math.min(segmentDuration, video_duration - startTime);
        
        if (actualDuration >= 30) { // At least 30 seconds
          await this.createSingleShort(originalVideoPath, shorts, {
            processing_id,
            subscription_type,
            startTime,
            duration: actualDuration,
            index: i
          });
        }
      }
    } else {
      // Smart segmentation within usable range
      const interval = usableDuration / numShorts;
      
      for (let i = 0; i < numShorts; i++) {
        const startTime = Math.floor(usableStart + (i * interval));
        const actualDuration = Math.min(segmentDuration, usableEnd - startTime);
        
        await this.createSingleShort(originalVideoPath, shorts, {
          processing_id,
          subscription_type,
          startTime,
          duration: actualDuration,
          index: i
        });
      }
    }
    
    if (shorts.length === 0) {
      throw new Error('Failed to create any valid video shorts');
    }
    
    return shorts;
  }

  async createSingleShort(originalVideoPath, shorts, options) {
    const { processing_id, subscription_type, startTime, duration, index } = options;
    
    const shortId = `short_${processing_id}_${index + 1}`;
    const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
    
    await this.extractSegment(originalVideoPath, shortPath, startTime, duration, subscription_type);
    
    // Get file stats
    const stats = await fs.stat(shortPath);
    
    shorts.push({
      short_id: shortId,
      title: `Video Short #${index + 1}`,
      local_path: shortPath,
      duration: Math.round(duration),
      start_time: startTime,
      file_size: stats.size,
      file_size_mb: Math.round(stats.size / 1024 / 1024 * 100) / 100,
      quality: subscription_type === 'free' ? '720p' : '1080p',
      segment_index: index + 1,
      watermark: subscription_type === 'free' ? '@VideoShortsBot' : null
    });
  }

  async extractSegment(inputPath, outputPath, startTime, duration, subscriptionType) {
    return new Promise((resolve, reject) => {
      const quality = subscriptionType === 'free' ? '720p' : '1080p';
      const resolution = quality === '720p' ? '1280x720' : '1920x1080';
      const videoBitrate = quality === '720p' ? '2500k' : '5000k';
      
      let command = ffmpeg(inputPath)
        .seekInput(startTime)
        .duration(duration)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(resolution)
        .videoBitrate(videoBitrate)
        .audioBitrate('128k')
        .format('mp4')
        .outputOptions([
          '-preset medium',
          '-crf 23',
          '-movflags +faststart',
          '-pix_fmt yuv420p',
          '-profile:v baseline',
          '-level 3.0'
        ]);
      
      // Add watermark for free users
      if (subscriptionType === 'free') {
        command = command.outputOptions([
          `-vf drawtext=text='@VideoShortsBot':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:x=10:y=H-th-10`
        ]);
      }
      
      command
        .on('start', (cmd) => {
          console.log(`FFmpeg command: ${cmd.substring(0, 100)}...`);
        })
        .on('progress', (progress) => {
          if (progress.percent && progress.percent % 25 === 0) {
            console.log(`Processing progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`Segment extraction completed: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          console.error(`FFmpeg error:`, error);
          reject(new Error(`Video processing failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async generateThumbnails(shorts, processingId) {
    console.log(`[${processingId}] Generating ${shorts.length} thumbnails`);
    
    for (let i = 0; i < shorts.length; i++) {
      const short = shorts[i];
      const thumbnailPath = path.join(this.outputDir, `${short.short_id}_thumb.jpg`);
      
      try {
        await this.extractThumbnail(short.local_path, thumbnailPath);
        short.thumbnail_path = thumbnailPath;
        
        const stats = await fs.stat(thumbnailPath);
        short.thumbnail_size = stats.size;
        
        console.log(`Generated thumbnail ${i + 1}/${shorts.length}`);
        
      } catch (error) {
        console.error(`Failed to generate thumbnail for ${short.short_id}:`, error);
        short.thumbnail_path = null;
      }
    }
    
    return shorts;
  }

  async extractThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput('00:00:03') // 3 seconds in
        .frames(1)
        .size('640x360')
        .format('image2')
        .outputOptions([
          '-q:v 2',
          '-update 1'
        ])
        .on('end', resolve)
        .on('error', reject)
        .save(thumbnailPath);
    });
  }

  async uploadToStorage(shorts, supabase, processingId) {
    console.log(`[${processingId}] Uploading ${shorts.length} shorts to storage`);
    
    const uploadedShorts = [];
    
    for (let i = 0; i < shorts.length; i++) {
      const short = shorts[i];
      
      try {
        console.log(`Uploading ${short.short_id} (${i + 1}/${shorts.length})...`);
        
        // Upload video
        const videoBuffer = await fs.readFile(short.local_path);
        const videoKey = `shorts/${processingId}/${short.short_id}.mp4`;
        
        const { error: videoError } = await supabase.storage
          .from('processed-shorts')
          .upload(videoKey, videoBuffer, {
            contentType: 'video/mp4',
            cacheControl: '3600',
            upsert: false
          });
        
        if (videoError) {
          console.error(`Video upload error for ${short.short_id}:`, videoError);
          continue; // Skip this short
        }
        
        // Upload thumbnail
        let thumbnailUrl = null;
        let thumbnailStoragePath = null;
        
        if (short.thumbnail_path) {
          try {
            const thumbnailBuffer = await fs.readFile(short.thumbnail_path);
            const thumbnailKey = `thumbnails/${processingId}/${short.short_id}.jpg`;
            
            const { error: thumbError } = await supabase.storage
              .from('thumbnails')
              .upload(thumbnailKey, thumbnailBuffer, {
                contentType: 'image/jpeg',
                cacheControl: '3600',
                upsert: false
              });
            
            if (!thumbError) {
              const { data: { publicUrl } } = supabase.storage
                .from('thumbnails')
                .getPublicUrl(thumbnailKey);
              
              thumbnailUrl = publicUrl;
              thumbnailStoragePath = thumbnailKey;
            }
          } catch (thumbError) {
            console.warn(`Thumbnail upload failed for ${short.short_id}:`, thumbError);
          }
        }
        
        // Get video public URL
        const { data: { publicUrl: videoUrl } } = supabase.storage
          .from('processed-shorts')
          .getPublicUrl(videoKey);
        
        uploadedShorts.push({
          short_id: short.short_id,
          title: short.title,
          file_url: videoUrl,
          thumbnail_url: thumbnailUrl,
          duration: short.duration,
          file_size_mb: short.file_size_mb,
          quality: short.quality,
          storage_path: videoKey,
          thumbnail_storage_path: thumbnailStoragePath,
          watermark: short.watermark,
          segment_index: short.segment_index,
          start_time: short.start_time,
          created_at: new Date().toISOString()
        });
        
        console.log(`Successfully uploaded ${short.short_id}`);
        
      } catch (error) {
        console.error(`Failed to upload ${short.short_id}:`, error);
      }
    }
    
    if (uploadedShorts.length === 0) {
      throw new Error('Failed to upload any video shorts to storage');
    }
    
    console.log(`[${processingId}] Successfully uploaded ${uploadedShorts.length}/${shorts.length} shorts`);
    return uploadedShorts;
  }

  async saveToDatabase(supabase, data) {
    try {
      // Save main processing record
      const { error: processError } = await supabase
        .from('video_processing')
        .upsert({
          processing_id: data.processing_id,
          original_url: data.video_info.url || null,
          platform: data.video_info.platform || 'Other',
          title: data.video_info.title,
          status: 'completed',
          subscription_type: data.subscription_type,
          metadata: {
            duration: data.metadata.duration,
            size_mb: data.metadata.size_mb,
            resolution: `${data.metadata.width}x${data.metadata.height}`,
            fps: data.metadata.fps,
            format: data.metadata.format,
            codec: data.metadata.codec,
            has_audio: data.metadata.has_audio
          },
          shorts_count: data.shorts.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (processError) {
        console.error('Database save error:', processError);
      }

      // Save individual shorts
      for (const short of data.shorts) {
        const { error: shortError } = await supabase
          .from('short_videos')
          .insert({
            short_id: short.short_id,
            processing_id: data.processing_id,
            title: short.title,
            file_url: short.file_url,
            thumbnail_url: short.thumbnail_url,
            storage_path: short.storage_path,
            duration: short.duration,
            file_size_mb: short.file_size_mb,
            quality: short.quality,
            segment_index: short.segment_index,
            start_time: short.start_time,
            has_watermark: !!short.watermark,
            created_at: new Date().toISOString()
          });

        if (shortError) {
          console.error(`Failed to save short ${short.short_id}:`, shortError);
        }
      }

    } catch (error) {
      console.error('Database save error:', error);
    }
  }

  async cleanup(processingId) {
    try {
      console.log(`[${processingId}] Cleaning up temporary files`);
      
      const directories = [this.tempDir, this.outputDir];
      let cleanedFiles = 0;

      for (const dir of directories) {
        try {
          const files = await fs.readdir(dir);
          const tempFiles = files.filter(file => 
            file.includes(processingId) || file.startsWith('preview_')
          );

          for (const file of tempFiles) {
            try {
              await fs.unlink(path.join(dir, file));
              cleanedFiles++;
            } catch (unlinkError) {
              console.error(`Failed to delete ${file}:`, unlinkError);
            }
          }
        } catch (readError) {
          console.error(`Failed to read directory ${dir}:`, readError);
        }
      }

      console.log(`[${processingId}] Cleaned up ${cleanedFiles} temporary files`);
    } catch (error) {
      console.error(`[${processingId}] Cleanup error:`, error);
    }
  }

  enhanceError(error, processingId) {
    const message = error.message.toLowerCase();
    
    if (message.includes('too large') || message.includes('file size')) {
      return new Error('Video file is too large for processing. Please try a smaller file.');
    } else if (message.includes('too long') || message.includes('duration')) {
      return new Error('Video is too long for processing. Please try a shorter video.');
    } else if (message.includes('too short')) {
      return new Error('Video is too short for shorts creation. Minimum 60 seconds required.');
    } else if (message.includes('resolution') || message.includes('too low')) {
      return new Error('Video resolution is too low. Minimum 480x360 required.');
    } else if (message.includes('download')) {
      return new Error('Failed to download video from URL. Please check the URL and try again.');
    } else if (message.includes('invalid content type')) {
      return new Error('Invalid file type. Please provide a valid video file.');
    } else if (message.includes('timeout')) {
      return new Error('Processing timeout. The video might be too large or complex.');
    } else if (message.includes('ffmpeg') || message.includes('encoding')) {
      return new Error('Video processing failed. The video format may not be supported.');
    } else if (message.includes('storage') || message.includes('upload')) {
      return new Error('Failed to save processed videos. Please try again.');
    } else if (message.includes('corrupted') || message.includes('invalid')) {
      return new Error('Video file appears to be corrupted or invalid.');
    } else {
      return new Error(`Video processing failed: ${error.message}`);
    }
  }
}

module.exports = BaseProcessor;