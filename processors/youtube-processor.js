// processors/youtube-processor.js
const ytdl = require('ytdl-core');
const ytdlDistube = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

class YouTubeProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 3;
    this.retryDelay = 2000;
  }

  async process(data) {
    const { 
      processing_id, 
      video_url, 
      video_info, 
      subscription_type, 
      supabase_config,
      user_limits = { max_shorts: 3 }
    } = data;
    
    console.log(`[${processing_id}] Starting YouTube video processing`);
    
    // Initialize Supabase client
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    
    try {
      // 1. Validate and prepare video URL
      console.log(`[${processing_id}] Validating YouTube URL`);
      const videoId = this.extractVideoId(video_url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL format');
      }
      
      // 2. Get video info and validate availability with fallback
      console.log(`[${processing_id}] Fetching video information`);
      const videoDetails = await this.getVideoInfoWithFallback(video_url, processing_id);
      
      // 3. Download video with multiple fallback methods
      console.log(`[${processing_id}] Downloading video with fallback methods`);
      originalVideoPath = await this.downloadVideoWithAllFallbacks(video_url, processing_id);
      
      // 4. Get video metadata
      const metadata = await this.getVideoMetadata(originalVideoPath);
      console.log(`[${processing_id}] Video duration: ${metadata.duration}s, resolution: ${metadata.width}x${metadata.height}`);
      
      // 5. Validate video for processing
      this.validateVideoForProcessing(metadata, subscription_type);
      
      // 6. Create shorts segments
      console.log(`[${processing_id}] Creating video shorts`);
      const shorts = await this.createShorts(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        video_info: { ...video_info, ...videoDetails }
      });
      
      // 7. Generate thumbnails for each short
      console.log(`[${processing_id}] Generating thumbnails`);
      const shortsWithThumbnails = await this.generateThumbnails(shorts, processing_id);
      
      // 8. Upload to Supabase Storage
      console.log(`[${processing_id}] Uploading to cloud storage`);
      const uploadedShorts = await this.uploadToStorage(shortsWithThumbnails, supabase, processing_id);
      
      // 9. Save processing record to database
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: { ...video_info, ...videoDetails },
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      // 10. Cleanup temporary files
      await this.cleanup(processing_id);
      
      console.log(`[${processing_id}] YouTube processing completed successfully`);
      
      return {
        processing_id,
        shorts_results: uploadedShorts,
        total_shorts: uploadedShorts.length,
        video_info: { ...video_info, ...videoDetails },
        platform: 'YouTube',
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
      console.error(`[${processing_id}] YouTube processing failed:`, error);
      
      // Cleanup on error
      if (originalVideoPath) {
        await this.cleanup(processing_id);
      }
      
      throw this.enhanceError(error, processing_id, video_url);
    }
  }

  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/v\/([^&\n?#]+)/,
      /youtube\.com\/watch\?.*v=([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    
    return null;
  }

  async getVideoInfoWithFallback(videoUrl, processingId) {
    const methods = [
      () => this.getVideoInfoDistube(videoUrl),
      () => this.getVideoInfoYtdlCore(videoUrl),
      () => this.getVideoInfoYoutubeDl(videoUrl)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying video info method ${index + 1}`);
        return await method();
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Video info method ${index + 1} failed: ${error.message}`);
      }
    }
    
    throw new Error(`All video info methods failed: ${lastError.message}`);
  }

  async getVideoInfoDistube(videoUrl) {
    try {
      const info = await ytdlDistube.getInfo(videoUrl);
      return this.extractVideoDetails(info.videoDetails);
    } catch (error) {
      throw new Error(`Distube getInfo failed: ${error.message}`);
    }
  }

  async getVideoInfoYtdlCore(videoUrl) {
    try {
      const info = await ytdl.getInfo(videoUrl);
      return this.extractVideoDetails(info.videoDetails);
    } catch (error) {
      throw new Error(`ytdl-core getInfo failed: ${error.message}`);
    }
  }

  async getVideoInfoYoutubeDl(videoUrl) {
    try {
      const info = await youtubedl(videoUrl, {
        dumpSingleJson: true,
        noCheckCertificate: true,
        noWarnings: true,
        preferFreeFormats: true
      });
      
      return {
        title: info.title || 'Unknown Title',
        description: (info.description || '').substring(0, 500),
        author: info.uploader || 'Unknown',
        duration: parseInt(info.duration) || 0,
        view_count: parseInt(info.view_count) || 0,
        upload_date: info.upload_date,
        video_id: info.id,
        thumbnail: info.thumbnail,
        is_live: info.is_live || false,
        category: info.categories?.[0] || 'Unknown'
      };
    } catch (error) {
      throw new Error(`youtube-dl-exec getInfo failed: ${error.message}`);
    }
  }

  extractVideoDetails(videoDetails) {
    // Check availability
    if (videoDetails.isPrivate) {
      throw new Error('Video is private or unavailable');
    }
    
    if (videoDetails.age_restricted) {
      throw new Error('Video is age-restricted and cannot be processed');
    }
    
    return {
      title: videoDetails.title,
      description: videoDetails.shortDescription?.substring(0, 500) || '',
      author: videoDetails.author?.name || 'Unknown',
      duration: parseInt(videoDetails.lengthSeconds) || 0,
      view_count: parseInt(videoDetails.viewCount) || 0,
      upload_date: videoDetails.publishDate || videoDetails.uploadDate,
      video_id: videoDetails.videoId,
      thumbnail: videoDetails.thumbnails?.[0]?.url,
      is_live: videoDetails.isLiveContent,
      category: videoDetails.category
    };
  }

  async downloadVideoWithAllFallbacks(videoUrl, processingId) {
    const methods = [
      () => this.downloadWithDistube(videoUrl, processingId),
      () => this.downloadWithYoutubeDl(videoUrl, processingId),
      () => this.downloadWithYtdlCore(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying download method ${index + 1}`);
        return await method();
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Download method ${index + 1} failed: ${error.message}`);
        
        // Wait before trying next method
        if (index < methods.length - 1) {
          await this.sleep(2000);
        }
      }
    }
    
    throw new Error(`All download methods failed: ${lastError.message}`);
  }

  async downloadWithDistube(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    return new Promise((resolve, reject) => {
      const timeoutMs = 300000; // 5 minutes
      let timeoutHandle;
      
      try {
        const stream = ytdlDistube(videoUrl, {
          quality: 'highest',
          filter: 'audioandvideo',
          requestOptions: {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
          }
        });
        
        const writeStream = require('fs').createWriteStream(outputPath);
        
        timeoutHandle = setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('Download timeout - video might be too large'));
        }, timeoutMs);
        
        stream.on('error', (error) => {
          clearTimeout(timeoutHandle);
          writeStream.destroy();
          reject(error);
        });
        
        writeStream.on('error', (error) => {
          clearTimeout(timeoutHandle);
          stream.destroy();
          reject(error);
        });
        
        writeStream.on('finish', () => {
          clearTimeout(timeoutHandle);
          resolve(outputPath);
        });
        
        stream.pipe(writeStream);
        
      } catch (error) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(error);
      }
    });
  }

  async getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to read video metadata: ${err.message}`));
          return;
        }
        
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const format = metadata.format;
        
        if (!videoStream) {
          reject(new Error('No video stream found in the file'));
          return;
        }
        
        resolve({
          duration: parseFloat(format.duration) || 0,
          size_bytes: parseInt(format.size) || 0,
          size_mb: Math.round((parseInt(format.size) || 0) / 1024 / 1024 * 100) / 100,
          width: videoStream.width,
          height: videoStream.height,
          fps: eval(videoStream.r_frame_rate) || 30,
          bitrate: parseInt(format.bit_rate) || 0,
          codec: videoStream.codec_name,
          format: format.format_name
        });
      });
    });
  }

  validateVideoForProcessing(metadata, subscriptionType) {
    // Check duration limits
    const maxDuration = subscriptionType === 'free' ? 600 : 1800; // 10 min free, 30 min premium
    if (metadata.duration > maxDuration) {
      throw new Error(`Video is too long. Maximum allowed: ${maxDuration / 60} minutes for ${subscriptionType} users`);
    }
    
    // Check file size limits
    const maxSizeMB = subscriptionType === 'free' ? 100 : 500;
    if (metadata.size_mb > maxSizeMB) {
      throw new Error(`Video file is too large. Maximum allowed: ${maxSizeMB}MB for ${subscriptionType} users`);
    }
    
    // Check resolution
    if (metadata.width < 480 || metadata.height < 360) {
      throw new Error('Video resolution is too low. Minimum required: 480x360');
    }
    
    console.log(`Video validation passed - Duration: ${metadata.duration}s, Size: ${metadata.size_mb}MB`);
  }

  async createShorts(originalVideoPath, options) {
    const { processing_id, subscription_type, user_limits, video_duration } = options;
    
    // Calculate number of shorts based on subscription
    const maxShorts = subscription_type === 'free' ? 
      Math.min(user_limits.max_shorts || 2, 2) : 
      Math.min(user_limits.max_shorts || 5, 8);
    
    const segmentDuration = 60; // 60 seconds per short
    const maxPossibleShorts = Math.floor(video_duration / segmentDuration);
    const numShorts = Math.min(maxShorts, maxPossibleShorts);
    
    if (numShorts === 0) {
      throw new Error('Video is too short to create any shorts (minimum 60 seconds required)');
    }
    
    console.log(`[${processing_id}] Creating ${numShorts} shorts from ${video_duration}s video`);
    
    const shorts = [];
    const interval = Math.max(segmentDuration, (video_duration - segmentDuration) / numShorts);
    
    for (let i = 0; i < numShorts; i++) {
      const startTime = Math.floor(i * interval);
      const actualDuration = Math.min(segmentDuration, video_duration - startTime);
      
      if (actualDuration < 30) continue; // Skip segments shorter than 30 seconds
      
      const shortId = `short_${processing_id}_${i + 1}`;
      const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
      
      await this.extractSegment(originalVideoPath, shortPath, startTime, actualDuration, subscription_type);
      
      // Get file size
      const stats = await fs.stat(shortPath);
      
      shorts.push({
        short_id: shortId,
        title: `Short Video #${i + 1}`,
        local_path: shortPath,
        duration: actualDuration,
        start_time: startTime,
        file_size: stats.size,
        file_size_mb: Math.round(stats.size / 1024 / 1024 * 100) / 100,
        quality: subscription_type === 'free' ? '720p' : '1080p',
        segment_index: i + 1,
        watermark: subscription_type === 'free' ? '@VideoShortsBot' : null
      });
    }
    
    return shorts;
  }

  async extractSegment(inputPath, outputPath, startTime, duration, subscriptionType) {
    return new Promise((resolve, reject) => {
      const quality = subscriptionType === 'free' ? '720p' : '1080p';
      const resolution = quality === '720p' ? '1280x720' : '1920x1080';
      const videoBitrate = quality === '720p' ? '2000k' : '4000k';
      
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
          '-preset fast',
          '-crf 23',
          '-movflags +faststart',
          '-pix_fmt yuv420p'
        ]);
      
      // Add watermark for free users
      if (subscriptionType === 'free') {
        command = command.outputOptions([
          `-vf drawtext=text='@VideoShortsBot':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:x=10:y=H-th-10`
        ]);
      }
      
      command
        .on('start', (cmd) => {
          console.log(`Starting ffmpeg: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Processing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`Segment extraction completed: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          console.error(`FFmpeg error: ${error.message}`);
          reject(new Error(`Video processing failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async generateThumbnails(shorts, processingId) {
    for (const short of shorts) {
      const thumbnailPath = path.join(
        this.outputDir,
        `${short.short_id}_thumbnail.jpg`
      );
      
      try {
        await this.extractThumbnail(short.local_path, thumbnailPath);
        short.thumbnail_path = thumbnailPath;
        
        // Get thumbnail file size
        const stats = await fs.stat(thumbnailPath);
        short.thumbnail_size = stats.size;
        
      } catch (error) {
        console.error(`[${processingId}] Failed to generate thumbnail for ${short.short_id}:`, error);
        short.thumbnail_path = null; // Will use default thumbnail
      }
    }
    
    return shorts;
  }

  async extractThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(5) // Extract frame at 5 seconds
        .frames(1)
        .size('640x360')
        .format('image2')
        .outputOptions([
          '-q:v 2', // High quality JPEG
          '-update 1'
        ])
        .on('end', resolve)
        .on('error', reject)
        .save(thumbnailPath);
    });
  }

  async uploadToStorage(shorts, supabase, processingId) {
    const uploadedShorts = [];
    
    for (const short of shorts) {
      try {
        console.log(`Uploading ${short.short_id} to storage...`);
        
        // Upload video file
        const videoBuffer = await fs.readFile(short.local_path);
        const videoKey = `shorts/${processingId}/${short.short_id}.mp4`;
        
        const { error: videoError } = await supabase.storage
          .from('processed-shorts')
          .upload(videoKey, videoBuffer, {
            contentType: 'video/mp4',
            cacheControl: '3600',
            upsert: false
          });
        
        if (videoError) throw videoError;
        
        // Upload thumbnail if available
        let thumbnailUrl = null;
        let thumbnailStoragePath = null;
        
        if (short.thumbnail_path) {
          try {
            const thumbnailBuffer = await fs.readFile(short.thumbnail_path);
            const thumbnailKey = `thumbnails/${processingId}/${short.short_id}.jpg`;
            
            const { error: thumbnailError } = await supabase.storage
              .from('thumbnails')
              .upload(thumbnailKey, thumbnailBuffer, {
                contentType: 'image/jpeg',
                cacheControl: '3600',
                upsert: false
              });
            
            if (!thumbnailError) {
              const { data: { publicUrl } } = supabase.storage
                .from('thumbnails')
                .getPublicUrl(thumbnailKey);
              
              thumbnailUrl = publicUrl;
              thumbnailStoragePath = thumbnailKey;
            }
          } catch (thumbError) {
            console.error(`Failed to upload thumbnail for ${short.short_id}:`, thumbError);
          }
        }
        
        // Get public URL for video
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
        // Continue with other shorts even if one fails
      }
    }
    
    if (uploadedShorts.length === 0) {
      throw new Error('Failed to upload any shorts to storage');
    }
    
    return uploadedShorts;
  }

  async saveToDatabase(supabase, data) {
    try {
      // Save main processing record
      const { error: processError } = await supabase
        .from('video_processing')
        .upsert({
          processing_id: data.processing_id,
          original_url: data.video_info.url,
          platform: 'YouTube',
          title: data.video_info.title,
          status: 'completed',
          subscription_type: data.subscription_type,
          metadata: {
            duration: data.metadata.duration,
            size_mb: data.metadata.size_mb,
            resolution: `${data.metadata.width}x${data.metadata.height}`,
            fps: data.metadata.fps,
            codec: data.metadata.codec
          },
          shorts_count: data.shorts.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (processError) {
        console.error('Failed to save processing record:', processError);
      }

      // Save individual shorts records
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
      // Don't throw error here as the processing was successful
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
          const tempFiles = files.filter(file => file.includes(processingId));

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

  enhanceError(error, processingId, videoUrl) {
    const message = error.message.toLowerCase();
    
    if (message.includes('video unavailable') || message.includes('private')) {
      return new Error('This YouTube video is private, unavailable, or has been deleted. Please try a different video.');
    } else if (message.includes('age-restricted') || message.includes('age_restricted')) {
      return new Error('This video is age-restricted and cannot be processed. Please try a different video.');
    } else if (message.includes('region') || message.includes('blocked')) {
      return new Error('This video is not available in your region. Please try a different video.');
    } else if (message.includes('timeout') || message.includes('network')) {
      return new Error('Network timeout occurred while processing the video. Please try again in a few minutes.');
    } else if (message.includes('too large') || message.includes('file size')) {
      return new Error('Video file is too large for processing. Please try a shorter or lower quality video.');
    } else if (message.includes('too long') || message.includes('duration')) {
      return new Error('Video is too long for processing. Please try a shorter video.');
    } else if (message.includes('ffmpeg') || message.includes('encoding')) {
      return new Error('Video encoding failed. The video format may not be supported.');
    } else if (message.includes('download')) {
      return new Error('Failed to download the video. Please check the URL and try again.');
    } else if (message.includes('storage') || message.includes('upload')) {
      return new Error('Failed to save processed videos. Please try again or contact support.');
    } else {
      // Return original error with processing context
      return new Error(`Video processing failed: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = YouTubeProcessor;

  async downloadWithYoutubeDl(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    
    try {
      await youtubedl(videoUrl, {
        output: outputTemplate,
        format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
        mergeOutputFormat: 'mp4',
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        addHeader: [
          'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]
      });
      
      // Find the downloaded file
      const files = await fs.readdir(this.tempDir);
      const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
      
      if (!outputFile) {
        throw new Error('Downloaded file not found');
      }
      
      return path.join(this.tempDir, outputFile);
      
    } catch (error) {
      throw new Error(`youtube-dl-exec download failed: ${error.message}`);
    }
  }

  async downloadWithYtdlCore(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    return new Promise((resolve, reject) => {
      const timeoutMs = 300000;
      let timeoutHandle;
      
      try {
        const stream = ytdl(videoUrl, {
          quality: 'highest',
          filter: format => {
            return format.container === 'mp4' && 
                   format.hasVideo && 
                   format.hasAudio;
          }
        });
        
        const writeStream = require('fs').createWriteStream(outputPath);
        
        timeoutHandle = setTimeout(()