// processors/youtube-processor.js - Enhanced with better bot detection avoidance
const ytdl = require('ytdl-core');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

class YouTubeProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 3;
    this.retryDelay = 2000;
    
    // Updated user agents (recent versions)
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
    ];

    // Rate limiting state
    this.lastRequestTime = 0;
    this.minRequestInterval = 5000; // 5 seconds between requests
    this.consecutiveFailures = 0;
    this.backoffTime = 0;
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    // Apply exponential backoff if we've had consecutive failures
    let waitTime = this.minRequestInterval;
    if (this.consecutiveFailures > 0) {
      waitTime = Math.min(60000, this.minRequestInterval * Math.pow(2, this.consecutiveFailures));
    }
    
    if (timeSinceLastRequest < waitTime) {
      const sleepTime = waitTime - timeSinceLastRequest;
      console.log(`Rate limiting: waiting ${sleepTime}ms (failures: ${this.consecutiveFailures})`);
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
    
    console.log(`[${processing_id}] Starting YouTube video processing`);
    
    // Validate Supabase config
    if (!supabase_config?.url || !supabase_config?.service_key) {
      throw new Error('Missing Supabase configuration (url or service_key)');
    }
    
    // Initialize Supabase client
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    const startTime = Date.now();
    
    try {
      // Ensure directories exist
      await this.ensureDirectories();
      
      // 1. Validate and prepare video URL
      console.log(`[${processing_id}] Validating YouTube URL`);
      const videoId = this.extractVideoId(video_url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL format');
      }
      
      console.log(`[${processing_id}] Extracted video ID: ${videoId}`);
      
      // 2. Get video info and validate availability with enhanced fallback
      console.log(`[${processing_id}] Fetching video information with enhanced bot avoidance`);
      const videoDetails = await this.getVideoInfoWithEnhancedFallback(video_url, processing_id);
      
      // 3. Download video with improved methods
      console.log(`[${processing_id}] Downloading video with enhanced anti-bot measures`);
      originalVideoPath = await this.downloadVideoWithImprovedFallbacks(video_url, processing_id);
      
      // 4. Validate downloaded file
      await this.validateDownloadedFile(originalVideoPath, processing_id);
      
      // 5. Get video metadata
      const metadata = await this.getVideoMetadata(originalVideoPath);
      console.log(`[${processing_id}] Video duration: ${metadata.duration}s, resolution: ${metadata.width}x${metadata.height}`);
      
      // 6. Validate video for processing
      this.validateVideoForProcessing(metadata, subscription_type);
      
      // 7. Create shorts segments
      console.log(`[${processing_id}] Creating video shorts`);
      const shorts = await this.createShorts(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        video_info: { ...video_info, ...videoDetails }
      });
      
      // 8. Generate thumbnails for each short
      console.log(`[${processing_id}] Generating thumbnails`);
      const shortsWithThumbnails = await this.generateThumbnails(shorts, processing_id);
      
      // 9. Upload to Supabase Storage
      console.log(`[${processing_id}] Uploading to cloud storage`);
      const uploadedShorts = await this.uploadToStorage(shortsWithThumbnails, supabase, processing_id);
      
      // 10. Save processing record to database
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: { ...video_info, ...videoDetails },
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      // 11. Cleanup temporary files
      await this.cleanup(processing_id);
      
      // Reset failure count on success
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
      
      // Increment failure count for backoff
      this.consecutiveFailures++;
      
      // Cleanup on error
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

  async getVideoInfoWithEnhancedFallback(videoUrl, processingId) {
    await this.enforceRateLimit();

    const methods = [
      () => this.getVideoInfoWithYtDlp(videoUrl, processingId),
      () => this.getVideoInfoWithPyTube(videoUrl, processingId),
      () => this.getVideoInfoFallbackMethod(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying enhanced video info method ${index + 1}`);
        const result = await method();
        console.log(`[${processingId}] Video info method ${index + 1} succeeded`);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Video info method ${index + 1} failed: ${error.message}`);
        
        // Enhanced backoff for bot detection
        if (this.isBotDetectionError(error)) {
          console.log(`[${processingId}] Bot detection suspected, applying enhanced backoff`);
          this.consecutiveFailures++;
          await this.sleep(Math.min(30000, 5000 * Math.pow(2, this.consecutiveFailures)));
        } else if (index < methods.length - 1) {
          await this.sleep(3000);
        }
      }
    }
    
    throw new Error(`All enhanced video info methods failed: ${lastError.message}`);
  }

  async getVideoInfoWithYtDlp(videoUrl, processingId) {
    try {
      const userAgent = this.getRandomUserAgent();
      
      // Use yt-dlp instead of youtube-dl-exec for better reliability
      const options = [
        '--dump-json',
        '--no-warnings',
        '--no-call-home',
        '--no-check-certificate',
        '--prefer-free-formats',
        '--user-agent', userAgent,
        '--referer', 'https://www.google.com/',
        '--add-header', `User-Agent:${userAgent}`,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--cookies-from-browser', 'chrome',
        '--sleep-interval', '2',
        '--max-sleep-interval', '10',
        '--format', 'best[height<=720]/best',
        videoUrl
      ];

      // Use spawn instead of the library to have more control
      const { spawn } = require('child_process');
      
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
            reject(new Error(`yt-dlp failed (code ${code}): ${errorMsg}`));
          }
        });

        // Timeout after 30 seconds
        setTimeout(() => {
          process.kill();
          reject(new Error('Video info request timeout'));
        }, 30000);
      });

    } catch (error) {
      throw new Error(`yt-dlp info extraction failed: ${error.message}`);
    }
  }

  async getVideoInfoWithPyTube(videoUrl, processingId) {
    try {
      // Alternative method using a different approach
      // This is a placeholder for a pytube-based solution
      // You would need to implement this with a Python subprocess call
      throw new Error('PyTube method not implemented yet');
    } catch (error) {
      throw new Error(`PyTube info extraction failed: ${error.message}`);
    }
  }

  async getVideoInfoFallbackMethod(videoUrl, processingId) {
    try {
      // Last resort: try to extract basic info from URL and make educated guesses
      const videoId = this.extractVideoId(videoUrl);
      if (!videoId) {
        throw new Error('Cannot extract video ID');
      }

      // Return minimal info to allow processing to continue
      return {
        title: `YouTube Video ${videoId}`,
        description: 'Video processing in progress',
        author: 'Unknown',
        duration: 0, // Will be detected from downloaded file
        view_count: 0,
        upload_date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
        video_id: videoId,
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        is_live: false,
        category: 'Unknown'
      };
    } catch (error) {
      throw new Error(`Fallback info extraction failed: ${error.message}`);
    }
  }

  async downloadVideoWithImprovedFallbacks(videoUrl, processingId) {
    const methods = [
      () => this.downloadWithYtDlpDirect(videoUrl, processingId),
      () => this.downloadWithAlternativeMethod(videoUrl, processingId),
      () => this.downloadWithBasicFallback(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying enhanced download method ${index + 1}`);
        await this.enforceRateLimit();
        
        const result = await method();
        console.log(`[${processingId}] Download method ${index + 1} succeeded`);
        this.consecutiveFailures = 0; // Reset on success
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Download method ${index + 1} failed: ${error.message}`);
        
        // Clean up failed download attempt
        try {
          const files = await fs.readdir(this.tempDir);
          const tempFiles = files.filter(file => file.includes(processingId));
          for (const file of tempFiles) {
            await fs.unlink(path.join(this.tempDir, file)).catch(() => {});
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        
        if (this.isBotDetectionError(error)) {
          console.log(`[${processingId}] Bot detection in download, applying enhanced backoff`);
          this.consecutiveFailures++;
          await this.sleep(Math.min(45000, 10000 * Math.pow(2, this.consecutiveFailures)));
        } else if (index < methods.length - 1) {
          await this.sleep(8000); // Longer wait between download attempts
        }
      }
    }
    
    throw new Error(`All enhanced download methods failed. Last error: ${lastError.message}`);
  }

  async downloadWithYtDlpDirect(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    const userAgent = this.getRandomUserAgent();
    
    try {
      console.log(`[${processingId}] yt-dlp: Starting direct download with enhanced avoidance`);
      
      const options = [
        '--output', outputTemplate,
        '--format', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--no-warnings',
        '--no-call-home',
        '--no-check-certificate',
        '--prefer-free-formats',
        '--user-agent', userAgent,
        '--referer', 'https://www.youtube.com/',
        '--add-header', `User-Agent:${userAgent}`,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '--retries', '3',
        '--fragment-retries', '3',
        '--skip-unavailable-fragments',
        '--limit-rate', '2M',
        '--sleep-interval', '3',
        '--max-sleep-interval', '15',
        '--cookies-from-browser', 'chrome',
        '--no-write-info-json',
        '--no-write-description',
        '--no-write-thumbnail',
        videoUrl
      ];

      const { spawn } = require('child_process');
      
      return new Promise((resolve, reject) => {
        const process = spawn('yt-dlp', options);
        let stderr = '';
        
        process.stderr.on('data', (data) => {
          stderr += data.toString();
          // Log progress
          const progress = data.toString();
          if (progress.includes('%')) {
            console.log(`[${processingId}] Download progress: ${progress.trim()}`);
          }
        });

        process.on('close', async (code) => {
          if (code === 0) {
            try {
              // Find the downloaded file
              const files = await fs.readdir(this.tempDir);
              const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
              
              if (!outputFile) {
                reject(new Error('Downloaded file not found'));
                return;
              }
              
              const filePath = path.join(this.tempDir, outputFile);
              console.log(`[${processingId}] yt-dlp: Download completed: ${outputFile}`);
              resolve(filePath);
            } catch (error) {
              reject(new Error(`Failed to locate downloaded file: ${error.message}`));
            }
          } else {
            const errorMsg = stderr || 'Unknown download error';
            if (errorMsg.toLowerCase().includes('sign in') || 
                errorMsg.toLowerCase().includes('bot') ||
                errorMsg.toLowerCase().includes('verify')) {
              reject(new Error('YouTube bot detection triggered'));
            } else {
              reject(new Error(`yt-dlp download failed (code ${code}): ${errorMsg}`));
            }
          }
        });

        // Longer timeout for downloads
        setTimeout(() => {
          process.kill();
          reject(new Error('Download timeout after 10 minutes'));
        }, 600000); // 10 minutes
      });
      
    } catch (error) {
      throw new Error(`yt-dlp direct download failed: ${error.message}`);
    }
  }

  async downloadWithAlternativeMethod(videoUrl, processingId) {
    // Alternative download method using different approach
    // This could use gallery-dl, youtube-dlc, or other tools
    throw new Error('Alternative download method not implemented yet');
  }

  async downloadWithBasicFallback(videoUrl, processingId) {
    // Basic fallback - very simple approach
    throw new Error('Basic fallback download method not implemented yet');
  }

  isBotDetectionError(error) {
    const errorMsg = error.message.toLowerCase();
    return errorMsg.includes('sign in to confirm') || 
           errorMsg.includes('bot') || 
           errorMsg.includes('verify') ||
           errorMsg.includes('captcha') ||
           errorMsg.includes('blocked') ||
           errorMsg.includes('403') ||
           errorMsg.includes('429') ||
           errorMsg.includes('quota');
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

      // Check for video file signatures
      const buffer = await fs.readFile(filePath, { start: 0, end: 100 });
      const header = buffer.toString('hex');
      
      const videoSignatures = [
        '00000018667479704d503431',
        '00000020667479704d503432',
        '1a45dfa3',
        '464c5601'
      ];
      
      const isVideoFile = videoSignatures.some(sig => header.includes(sig)) || 
                         header.includes('ftyp') || 
                         header.includes('moov');
      
      if (!isVideoFile) {
        throw new Error('Downloaded file does not appear to be a valid video file');
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
    
    if (message.includes('sign in to confirm') || message.includes('bot')) {
      return new Error('YouTube has detected automated access and is blocking the request. This is temporary - please try again in a few minutes or try a different video.');
    } else if (message.includes('video unavailable') || message.includes('private')) {
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
    } else if (message.includes('invalid data') || message.includes('no video stream')) {
      return new Error('The downloaded file appears to be corrupted or invalid. This may be due to YouTube bot detection. Please try again later.');
    } else if (message.includes('ffmpeg') || message.includes('encoding')) {
      return new Error('Video encoding failed. The video format may not be supported.');
    } else if (message.includes('download')) {
      return new Error('Failed to download the video. Please check the URL and try again.');
    } else if (message.includes('storage') || message.includes('upload')) {
      return new Error('Failed to save processed videos. Please try again or contact support.');
    } else if (message.includes('supabase')) {
      return new Error('Storage service error. Please try again or contact support.');
    } else {
      return new Error(`Video processing failed: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = YouTubeProcessor;