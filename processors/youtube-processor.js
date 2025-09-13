// processors/youtube-processor-improved.js - 2025 Anti-Detection Optimized
const ytdl = require('ytdl-core');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const https = require('https');

class YouTubeProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 3; // Reduced from 5
    
    // Updated 2025 browser profiles - more conservative approach
    this.stableBrowserProfile = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Win32'
    };
    
    // Simplified rate limiting - less suspicious
    this.lastRequestTime = 0;
    this.minRequestInterval = 8000; // Reduced to 8 seconds
    this.consecutiveFailures = 0;
    
    this.initializeTools();
  }

  async initializeTools() {
    this.availableTools = {
      ytDlp: await this.checkYtDlp(),
      youtubeDl: await this.checkYoutubeDl(),
      ytdlCore: true
    };
    
    console.log('Available YouTube tools:', this.availableTools);
  }

  async checkYtDlp() {
    return new Promise((resolve) => {
      exec('yt-dlp --version', (error, stdout) => {
        if (!error && stdout) {
          console.log('yt-dlp version:', stdout.trim());
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  async checkYoutubeDl() {
    return new Promise((resolve) => {
      exec('youtube-dl --version', (error, stdout) => {
        resolve(!error);
      });
    });
  }

  async enforceSimpleRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    // Simple consistent delay - less suspicious than variable delays
    if (timeSinceLastRequest < this.minRequestInterval) {
      const sleepTime = this.minRequestInterval - timeSinceLastRequest;
      console.log(`Rate limit: waiting ${Math.round(sleepTime/1000)}s`);
      await this.sleep(sleepTime);
    }
    
    this.lastRequestTime = Date.now();
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
    
    console.log(`[${processing_id}] Starting improved YouTube processing`);
    
    if (!supabase_config?.url || !supabase_config?.service_key) {
      throw new Error('Missing Supabase configuration (url or service_key)');
    }
    
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    const startTime = Date.now();
    
    try {
      await this.ensureDirectories();
      
      console.log(`[${processing_id}] Validating YouTube URL`);
      const videoId = this.extractVideoId(video_url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL format');
      }
      
      console.log(`[${processing_id}] Fetching video information`);
      const videoDetails = await this.getVideoInfoImproved(video_url, processing_id);
      
      console.log(`[${processing_id}] Downloading video with improved method`);
      originalVideoPath = await this.downloadVideoImproved(video_url, processing_id);
      
      await this.validateDownloadedFile(originalVideoPath, processing_id);
      
      const metadata = await this.getVideoMetadata(originalVideoPath);
      console.log(`[${processing_id}] Video metadata: ${metadata.duration}s, ${metadata.width}x${metadata.height}, ${metadata.size_mb}MB`);
      
      this.validateVideoForProcessing(metadata, subscription_type);
      
      console.log(`[${processing_id}] Creating video shorts`);
      const shorts = await this.createShorts(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        video_info: { ...video_info, ...videoDetails }
      });
      
      console.log(`[${processing_id}] Generating thumbnails`);
      const shortsWithThumbnails = await this.generateThumbnails(shorts, processing_id);
      
      console.log(`[${processing_id}] Uploading to cloud storage`);
      const uploadedShorts = await this.uploadToStorage(shortsWithThumbnails, supabase, processing_id);
      
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: { ...video_info, ...videoDetails },
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      await this.cleanup(processing_id);
      
      this.consecutiveFailures = 0;
      
      const processingTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${processing_id}] YouTube processing completed successfully in ${processingTime}s`);
      
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
          processing_time_seconds: processingTime,
          shorts_total_duration: uploadedShorts.reduce((sum, short) => sum + (short.duration || 60), 0),
          storage_method: 'supabase'
        }
      };
      
    } catch (error) {
      console.error(`[${processing_id}] YouTube processing failed:`, error);
      this.consecutiveFailures++;
      
      if (originalVideoPath) {
        await this.cleanup(processing_id);
      }
      
      throw this.enhanceError(error, processing_id, video_url);
    }
  }

  async ensureDirectories() {
    const dirs = [this.tempDir, this.outputDir];
    
    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        console.error(`Failed to create directory ${dir}:`, error);
      }
    }
  }

  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?.*[&?]v=([a-zA-Z0-9_-]{11})/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    
    return null;
  }

  async getVideoInfoImproved(videoUrl, processingId) {
    // Try methods in order of least to most detectable
    const methods = [
      () => this.getVideoInfoViaOEmbed(videoUrl, processingId),
      () => this.getVideoInfoWithYtdlCoreSimple(videoUrl, processingId),
      ...(this.availableTools.ytDlp ? [
        () => this.getVideoInfoWithYtDlpSimple(videoUrl, processingId)
      ] : []),
      () => this.getVideoInfoFallback(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying video info method ${index + 1}/${methods.length}`);
        
        if (index > 0) {
          await this.enforceSimpleRateLimit();
        }
        
        const result = await method();
        console.log(`[${processingId}] Video info method ${index + 1} succeeded`);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Video info method ${index + 1} failed: ${error.message}`);
        
        // Only add delay between methods, not exponential backoff
        if (index < methods.length - 1) {
          await this.sleep(2000);
        }
      }
    }
    
    throw new Error(`All video info methods failed: ${lastError.message}`);
  }

  async getVideoInfoWithYtDlpSimple(videoUrl, processingId) {
    const options = [
      '--dump-json',
      '--no-warnings',
      '--no-call-home',
      '--socket-timeout', '30',
      '--user-agent', this.stableBrowserProfile.userAgent,
      videoUrl
    ];
    
    return new Promise((resolve, reject) => {
      const process = spawn('yt-dlp', options);
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const info = JSON.parse(stdout.trim());
            resolve({
              title: info.title || 'Unknown Title',
              description: (info.description || '').substring(0, 500),
              author: info.uploader || info.channel || 'Unknown',
              duration: parseInt(info.duration) || 0,
              view_count: parseInt(info.view_count) || 0,
              upload_date: info.upload_date,
              video_id: info.id,
              thumbnail: info.thumbnail,
              is_live: info.is_live || false,
              category: info.categories?.[0] || 'Unknown'
            });
          } catch (parseError) {
            reject(new Error(`Failed to parse video info: ${parseError.message}`));
          }
        } else {
          const errorMsg = stderr || stdout || 'Unknown error';
          reject(new Error(`yt-dlp failed: ${errorMsg}`));
        }
      });

      setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error('Video info request timeout'));
      }, 45000);
    });
  }

  async getVideoInfoWithYtdlCoreSimple(videoUrl, processingId) {
    try {
      const options = {
        requestOptions: {
          timeout: 30000,
          headers: {
            'User-Agent': this.stableBrowserProfile.userAgent,
            'Accept-Language': this.stableBrowserProfile.acceptLanguage
          }
        }
      };

      const info = await ytdl.getInfo(videoUrl, options);
      const details = info.videoDetails;
      
      return {
        title: details.title || 'Unknown Title',
        description: (details.description || '').substring(0, 500),
        author: details.author?.name || 'Unknown',
        duration: parseInt(details.lengthSeconds) || 0,
        view_count: parseInt(details.viewCount) || 0,
        upload_date: details.publishDate || new Date().toISOString(),
        video_id: details.videoId,
        thumbnail: details.thumbnails?.[0]?.url,
        is_live: details.isLiveContent || false,
        category: details.category || 'Unknown'
      };
    } catch (error) {
      throw new Error(`ytdl-core failed: ${error.message}`);
    }
  }

  async getVideoInfoViaOEmbed(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID for oEmbed method');
    }

    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      
      const response = await axios.get(oembedUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': this.stableBrowserProfile.userAgent,
          'Accept': 'application/json'
        }
      });

      const data = response.data;
      
      return {
        title: data.title || 'Unknown Title',
        description: 'Retrieved via oEmbed API',
        author: data.author_name || 'Unknown',
        duration: 0,
        view_count: 0,
        upload_date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
        video_id: videoId,
        thumbnail: data.thumbnail_url,
        is_live: false,
        category: 'Unknown'
      };
    } catch (error) {
      throw new Error(`oEmbed API method failed: ${error.message}`);
    }
  }

  async getVideoInfoFallback(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID');
    }

    return {
      title: `YouTube Video ${videoId}`,
      description: 'Fallback video info',
      author: 'Unknown',
      duration: 0,
      view_count: 0,
      upload_date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
      video_id: videoId,
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      is_live: false,
      category: 'Unknown'
    };
  }

  async downloadVideoImproved(videoUrl, processingId) {
    // Simplified approach - try each method once with proper delays
    const methods = [
      () => this.downloadWithYtdlCoreStable(videoUrl, processingId),
      ...(this.availableTools.ytDlp ? [
        () => this.downloadWithYtDlpStable(videoUrl, processingId)
      ] : [])
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processing_id}] Trying download method ${index + 1}/${methods.length}`);
        
        if (index > 0) {
          await this.enforceSimpleRateLimit();
        }
        
        const result = await method();
        console.log(`[${processing_id}] Download method ${index + 1} succeeded`);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processing_id}] Download method ${index + 1} failed: ${error.message}`);
        
        await this.cleanupFailedDownload(processingId);
        
        // Simple delay between methods
        if (index < methods.length - 1) {
          await this.sleep(10000); // 10 second delay
        }
      }
    }
    
    throw new Error(`All download methods failed. Last error: ${lastError.message}`);
  }

  async downloadWithYtdlCoreStable(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    return new Promise((resolve, reject) => {
      try {
        const options = {
          quality: 'highestvideo[height<=720]',
          filter: 'audioandvideo',
          requestOptions: {
            timeout: 60000,
            headers: {
              'User-Agent': this.stableBrowserProfile.userAgent,
              'Accept-Language': this.stableBrowserProfile.acceptLanguage
            }
          }
        };

        const stream = ytdl(videoUrl, options);
        const writeStream = fsSync.createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        let lastProgress = 0;
        stream.on('progress', (chunkLength, downloaded, total) => {
          if (total > 0) {
            const percent = (downloaded / total * 100);
            if (percent - lastProgress > 20) {
              console.log(`[${processingId}] Download progress: ${percent.toFixed(1)}%`);
              lastProgress = percent;
            }
          }
        });
        
        stream.on('error', (error) => {
          writeStream.destroy();
          reject(new Error(`Stream error: ${error.message}`));
        });
        
        writeStream.on('error', (error) => {
          reject(new Error(`Write error: ${error.message}`));
        });
        
        writeStream.on('finish', () => {
          console.log(`[${processingId}] Download completed: ${outputPath}`);
          resolve(outputPath);
        });
        
        setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('Download timeout'));
        }, 600000); // 10 minutes timeout
        
      } catch (error) {
        reject(new Error(`ytdl-core setup failed: ${error.message}`));
      }
    });
  }

  async downloadWithYtDlpStable(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    
    const options = [
      '--output', outputTemplate,
      '--format', 'best[height<=720][ext=mp4]/best[ext=mp4]',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--socket-timeout', '45',
      '--retries', '1',
      '--user-agent', this.stableBrowserProfile.userAgent,
      videoUrl
    ];
    
    return new Promise((resolve, reject) => {
      const process = spawn('yt-dlp', options);
      let stderr = '';
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        const progress = data.toString();
        if (progress.includes('%') && !progress.includes('ERROR')) {
          console.log(`[${processingId}] yt-dlp: ${progress.trim()}`);
        }
      });

      process.on('close', async (code) => {
        if (code === 0) {
          try {
            const files = await fs.readdir(this.tempDir);
            const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
            
            if (!outputFile) {
              reject(new Error('Downloaded file not found'));
              return;
            }
            
            const filePath = path.join(this.tempDir, outputFile);
            console.log(`[${processingId}] yt-dlp download completed: ${outputFile}`);
            resolve(filePath);
          } catch (error) {
            reject(new Error(`Failed to locate downloaded file: ${error.message}`));
          }
        } else {
          const errorMsg = stderr || 'Unknown download error';
          reject(new Error(`yt-dlp failed: ${errorMsg}`));
        }
      });

      setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error('Download timeout'));
      }, 600000); // 10 minutes timeout
    });
  }

  async cleanupFailedDownload(processingId) {
    try {
      const files = await fs.readdir(this.tempDir);
      const tempFiles = files.filter(file => file.includes(processingId));
      for (const file of tempFiles) {
        await fs.unlink(path.join(this.tempDir, file)).catch(() => {});
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  async validateDownloadedFile(filePath, processingId) {
    try {
      const stats = await fs.stat(filePath);
      
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }
      
      if (stats.size < 1024) {
        const content = await fs.readFile(filePath, 'utf8');
        if (content.includes('<!DOCTYPE html>') || content.includes('<html>')) {
          throw new Error('Downloaded file is HTML (likely bot detection page)');
        }
      }

      console.log(`[${processingId}] Downloaded file validation passed - Size: ${Math.round(stats.size / 1024 / 1024)}MB`);
      
    } catch (error) {
      console.error(`[${processingId}] File validation failed:`, error);
      throw new Error(`Downloaded file validation failed: ${error.message}`);
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
    const maxDuration = subscriptionType === 'free' ? 600 : 1800;
    if (metadata.duration > maxDuration) {
      throw new Error(`Video is too long. Maximum allowed: ${maxDuration / 60} minutes for ${subscriptionType} users`);
    }
    
    const maxSizeMB = subscriptionType === 'free' ? 100 : 500;
    if (metadata.size_mb > maxSizeMB) {
      throw new Error(`Video file is too large. Maximum allowed: ${maxSizeMB}MB for ${subscriptionType} users`);
    }
    
    if (metadata.width < 480 || metadata.height < 360) {
      throw new Error('Video resolution is too low. Minimum required: 480x360');
    }
    
    console.log(`Video validation passed - Duration: ${metadata.duration}s, Size: ${metadata.size_mb}MB`);
  }

  async createShorts(originalVideoPath, options) {
    const { processing_id, subscription_type, user_limits, video_duration } = options;
    
    const maxShorts = subscription_type === 'free' ? 
      Math.min(user_limits.max_shorts || 2, 2) : 
      Math.min(user_limits.max_shorts || 5, 8);
    
    const segmentDuration = 60;
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
      
      if (actualDuration < 30) continue;
      
      const shortId = `short_${processing_id}_${i + 1}`;
      const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
      
      await this.extractSegment(originalVideoPath, shortPath, startTime, actualDuration, subscription_type);
      
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
          '-pix_fmt yuv420p',
          '-avoid_negative_ts make_zero'
        ]);
      
      if (subscriptionType === 'free') {
        command = command.outputOptions([
          `-vf drawtext=text='@VideoShortsBot':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:x=10:y=H-th-10`
        ]);
      }
      
      command
        .on('progress', (progress) => {
          if (progress.percent && progress.percent % 25 === 0) {
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
        
        const stats = await fs.stat(thumbnailPath);
        short.thumbnail_size = stats.size;
        
      } catch (error) {
        console.error(`[${processingId}] Failed to generate thumbnail for ${short.short_id}:`, error);
        short.thumbnail_path = null;
      }
    }
    
    return shorts;
  }

  async extractThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(5)
        .frames(1)
        .size('640x360')
        .format('image2')
        .outputOptions(['-q:v 2'])
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
      throw new Error('Failed to upload any shorts to storage');
    }
    
    return uploadedShorts;
  }

  async saveToDatabase(supabase, data) {
    try {
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
    
    if (message.includes('410') || message.includes('bot') || message.includes('sign in to confirm')) {
      return new Error('YouTube has detected automated access. Please try a different video or wait 30-60 minutes before trying again.');
    } else if (message.includes('video unavailable') || message.includes('private')) {
      return new Error('This YouTube video is private, unavailable, or has been deleted. Please verify the URL and try a different video.');
    } else if (message.includes('age-restricted')) {
      return new Error('This video is age-restricted and cannot be processed. Please try a different video.');
    } else if (message.includes('region') || message.includes('blocked')) {
      return new Error('This video is not available in your region. Please try a different video.');
    } else if (message.includes('timeout') || message.includes('network')) {
      return new Error('Network timeout occurred. Please try again in a few minutes.');
    } else if (message.includes('too large') || message.includes('file size')) {
      return new Error('Video file is too large for processing. Please try a shorter video.');
    } else if (message.includes('too long') || message.includes('duration')) {
      return new Error('Video is too long for processing. Please try a shorter video.');
    } else if (message.includes('ffmpeg') || message.includes('encoding')) {
      return new Error('Video encoding failed. The video format may not be supported.');
    } else if (message.includes('download')) {
      return new Error('Failed to download the video. Please check the URL and try again.');
    } else if (message.includes('storage') || message.includes('upload')) {
      return new Error('Failed to save processed videos. Please try again.');
    } else {
      return new Error(`Video processing failed: ${error.message}. Please try again or contact support.`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = YouTubeProcessor;