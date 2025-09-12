// processors/youtube-processor-enhanced.js - Enhanced with better bot detection avoidance
const ytdl = require('ytdl-core');
const ytdlDistube = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

class EnhancedYouTubeProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 5; // Increased retries
    this.retryDelay = 5000; // Increased base delay
    
    // More diverse user agents with recent versions
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
    ];

    // Initialize rate limiting tracker
    this.rateLimitTracker = new Map();
    this.lastRequestTime = 0;
    this.minRequestInterval = 2000; // Minimum 2 seconds between requests
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  generateRandomSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      console.log(`Rate limiting: waiting ${waitTime}ms`);
      await this.sleep(waitTime);
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
    
    console.log(`[${processing_id}] Starting enhanced YouTube video processing`);
    
    // Initialize Supabase client
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    
    try {
      // Ensure directories exist
      await this.ensureDirectories();
      
      // 1. Enhanced URL validation and cleanup
      console.log(`[${processing_id}] Validating and cleaning YouTube URL`);
      const cleanUrl = this.cleanYouTubeUrl(video_url);
      const videoId = this.extractVideoId(cleanUrl);
      if (!videoId) {
        throw new Error('Invalid YouTube URL format');
      }
      
      console.log(`[${processing_id}] Extracted video ID: ${videoId}`);
      
      // 2. Pre-flight check with exponential backoff
      console.log(`[${processing_id}] Performing pre-flight availability check`);
      await this.preflightCheck(cleanUrl, processing_id);
      
      // 3. Get video info with enhanced retry logic
      console.log(`[${processing_id}] Fetching video information with enhanced retry`);
      const videoDetails = await this.getVideoInfoWithEnhancedRetry(cleanUrl, processing_id);
      
      // 4. Download video with all fallback methods and validation
      console.log(`[${processing_id}] Starting download with enhanced validation`);
      originalVideoPath = await this.downloadVideoWithEnhancedFallbacks(cleanUrl, processing_id);
      
      // 5. Comprehensive file validation
      await this.comprehensiveFileValidation(originalVideoPath, processing_id);
      
      // 6. Get video metadata
      const metadata = await this.getVideoMetadata(originalVideoPath);
      console.log(`[${processing_id}] Video metadata - Duration: ${metadata.duration}s, Size: ${metadata.size_mb}MB, Resolution: ${metadata.width}x${metadata.height}`);
      
      // 7. Validate video for processing
      this.validateVideoForProcessing(metadata, subscription_type);
      
      // 8. Create shorts segments with smart timing
      console.log(`[${processing_id}] Creating video shorts with smart segmentation`);
      const shorts = await this.createShortsWithSmartSegmentation(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        video_info: { ...video_info, ...videoDetails }
      });
      
      // 9. Generate thumbnails with fallback
      console.log(`[${processing_id}] Generating thumbnails with fallback`);
      const shortsWithThumbnails = await this.generateThumbnailsWithFallback(shorts, processing_id);
      
      // 10. Upload to Supabase Storage with retry
      console.log(`[${processing_id}] Uploading to cloud storage with retry logic`);
      const uploadedShorts = await this.uploadToStorageWithRetry(shortsWithThumbnails, supabase, processing_id);
      
      // 11. Save processing record to database
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: { ...video_info, ...videoDetails },
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      // 12. Cleanup temporary files
      await this.cleanup(processing_id);
      
      console.log(`[${processing_id}] Enhanced YouTube processing completed successfully`);
      
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
          processing_time: `${Math.round((Date.now() - Date.now()) / 1000)} seconds`,
          shorts_total_duration: uploadedShorts.reduce((sum, short) => sum + (short.duration || 60), 0)
        }
      };
      
    } catch (error) {
      console.error(`[${processing_id}] Enhanced YouTube processing failed:`, error);
      
      // Enhanced error handling and cleanup
      if (originalVideoPath) {
        await this.cleanup(processing_id);
      }
      
      throw this.enhanceError(error, processing_id, video_url);
    }
  }

  cleanYouTubeUrl(url) {
    // Remove tracking parameters and clean up URL
    const cleanUrl = url.split('&')[0].split('?')[0];
    const videoId = this.extractVideoId(url);
    
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    
    return url;
  }

  async preflightCheck(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    
    try {
      // Quick availability check using YouTube's oembed API
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
      
      const response = await axios.get(oembedUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (response.status === 200 && response.data.title) {
        console.log(`[${processingId}] Pre-flight check passed: "${response.data.title}"`);
        return true;
      }
      
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('Video is private, unlisted, or requires authentication');
      } else if (error.response?.status === 404) {
        throw new Error('Video not found or has been deleted');
      }
      
      console.warn(`[${processingId}] Pre-flight check inconclusive: ${error.message}`);
      // Don't fail here, continue with main processing
    }
  }

  async getVideoInfoWithEnhancedRetry(videoUrl, processingId) {
    const methods = [
      () => this.getVideoInfoYoutubeDlEnhanced(videoUrl, processingId),
      () => this.getVideoInfoDistubeEnhanced(videoUrl, processingId),
      () => this.getVideoInfoYtdlCoreEnhanced(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      const maxAttempts = 3;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.waitForRateLimit();
          
          console.log(`[${processingId}] Trying video info method ${index + 1}, attempt ${attempt}`);
          const result = await method();
          console.log(`[${processingId}] Video info method ${index + 1} succeeded on attempt ${attempt}`);
          return result;
        } catch (error) {
          lastError = error;
          const isRateLimited = this.isRateLimitError(error);
          const isBotDetection = this.isBotDetectionError(error);
          
          console.warn(`[${processingId}] Video info method ${index + 1}, attempt ${attempt} failed: ${error.message}`);
          
          if (isBotDetection && attempt === maxAttempts) {
            // If it's bot detection on final attempt, wait longer before trying next method
            await this.sleep(10000 + Math.random() * 5000);
          } else if (isRateLimited) {
            // Exponential backoff for rate limiting
            const waitTime = Math.min(30000, 2000 * Math.pow(2, attempt - 1)) + Math.random() * 1000;
            console.log(`[${processingId}] Rate limited, waiting ${waitTime}ms`);
            await this.sleep(waitTime);
          } else if (attempt < maxAttempts) {
            // Regular retry delay
            await this.sleep(2000 * attempt);
          }
        }
      }
    }
    
    throw new Error(`All video info methods failed: ${lastError.message}`);
  }

  async downloadVideoWithEnhancedFallbacks(videoUrl, processingId) {
    const methods = [
      () => this.downloadWithYoutubeDlEnhanced(videoUrl, processingId),
      () => this.downloadWithDistubeEnhanced(videoUrl, processingId),
      () => this.downloadWithYtdlCoreEnhanced(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      const maxAttempts = 3;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.waitForRateLimit();
          
          console.log(`[${processingId}] Trying download method ${index + 1}, attempt ${attempt}`);
          const result = await method();
          
          // Validate the downloaded file immediately
          await this.comprehensiveFileValidation(result, processingId);
          
          console.log(`[${processingId}] Download method ${index + 1} succeeded on attempt ${attempt}`);
          return result;
        } catch (error) {
          lastError = error;
          const isRateLimited = this.isRateLimitError(error);
          const isBotDetection = this.isBotDetectionError(error);
          
          console.warn(`[${processingId}] Download method ${index + 1}, attempt ${attempt} failed: ${error.message}`);
          
          // Clean up failed download attempt
          await this.cleanupFailedDownload(processingId);
          
          if (isBotDetection && attempt === maxAttempts) {
            // If it's bot detection on final attempt, wait longer
            const waitTime = 15000 + Math.random() * 10000; // 15-25 seconds
            console.log(`[${processingId}] Bot detection, waiting ${waitTime}ms before next method`);
            await this.sleep(waitTime);
          } else if (isRateLimited) {
            // Exponential backoff for rate limiting
            const waitTime = Math.min(60000, 5000 * Math.pow(2, attempt - 1)) + Math.random() * 2000;
            console.log(`[${processingId}] Rate limited, waiting ${waitTime}ms`);
            await this.sleep(waitTime);
          } else if (attempt < maxAttempts) {
            // Regular retry delay with jitter
            const waitTime = 3000 * attempt + Math.random() * 2000;
            await this.sleep(waitTime);
          }
        }
      }
    }
    
    throw new Error(`All download methods failed. Last error: ${lastError.message}`);
  }

  isRateLimitError(error) {
    const message = error.message.toLowerCase();
    return message.includes('rate limit') || 
           message.includes('too many requests') ||
           message.includes('429') ||
           message.includes('throttle');
  }

  isBotDetectionError(error) {
    const message = error.message.toLowerCase();
    return message.includes('bot') ||
           message.includes('sign in to confirm') ||
           message.includes('verify') ||
           message.includes('captcha') ||
           message.includes('automated') ||
           message.includes('suspicious activity');
  }

  async downloadWithYoutubeDlEnhanced(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    const userAgent = this.getRandomUserAgent();
    const sessionId = this.generateRandomSessionId();
    
    try {
      console.log(`[${processingId}] youtube-dl-exec: Enhanced download starting`);
      
      const options = {
        output: outputTemplate,
        format: 'best[height<=1080][ext=mp4]/best[ext=mp4]/mp4/best',
        mergeOutputFormat: 'mp4',
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        userAgent: userAgent,
        referer: 'https://www.youtube.com/',
        addHeader: [
          `User-Agent:${userAgent}`,
          'Accept-Language:en-US,en;q=0.9,*;q=0.8',
          'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Encoding:gzip, deflate, br',
          'Connection:keep-alive',
          'Upgrade-Insecure-Requests:1',
          'Sec-Fetch-Dest:document',
          'Sec-Fetch-Mode:navigate',
          'Sec-Fetch-Site:cross-site',
          `X-Session-ID:${sessionId}`
        ],
        // Enhanced retry and fragment handling
        retries: 5,
        fragmentRetries: 5,
        skipUnavailableFragments: true,
        keepFragments: false,
        abortOnUnavailableFragment: false,
        // Add random sleep to appear more human-like
        sleep: Math.floor(Math.random() * 3) + 2, // 2-4 seconds
        maxSleepInterval: 5,
        // Additional extraction options
        extractFlat: false,
        writeInfoJson: false,
        writeThumbnail: false,
        // Network options
        socketTimeout: 30,
        // Geo bypass
        geoBypass: true,
        geoBypassCountry: 'US'
      };
      
      await youtubedl(videoUrl, options);
      
      // Find the downloaded file
      const files = await fs.readdir(this.tempDir);
      const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
      
      if (!outputFile) {
        throw new Error('Downloaded file not found after youtube-dl-exec completion');
      }
      
      const filePath = path.join(this.tempDir, outputFile);
      console.log(`[${processingId}] youtube-dl-exec: Download completed: ${outputFile}`);
      
      return filePath;
      
    } catch (error) {
      console.error(`[${processingId}] youtube-dl-exec enhanced download error:`, error.message);
      
      // Enhanced error classification
      if (this.isBotDetectionError(error)) {
        throw new Error('YouTube bot detection triggered during download. Implementing countermeasures...');
      } else if (this.isRateLimitError(error)) {
        throw new Error('Rate limited by YouTube. Will retry with backoff...');
      } else if (error.message.includes('unavailable') || error.message.includes('removed')) {
        throw new Error('Video is no longer available or has been removed');
      }
      
      throw new Error(`youtube-dl-exec enhanced download failed: ${error.message}`);
    }
  }

  async comprehensiveFileValidation(filePath, processingId) {
    try {
      const stats = await fs.stat(filePath);
      
      // Check file size
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty (0 bytes)');
      }
      
      if (stats.size < 10240) { // Less than 10KB is likely an error
        const content = await fs.readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('<!DOCTYPE html>') || 
            content.includes('<html>') ||
            content.includes('bot detection') ||
            content.includes('verify you are human')) {
          throw new Error('Downloaded file contains HTML error page (likely bot detection)');
        }
      }
      
      // Check file signature for MP4
      const buffer = Buffer.alloc(12);
      const fd = await fs.open(filePath, 'r');
      await fd.read(buffer, 0, 12, 0);
      await fd.close();
      
      // Check for MP4 signature (ftyp)
      const signature = buffer.toString('ascii', 4, 8);
      const validSignatures = ['ftyp', 'mdat', 'moov', 'wide'];
      
      if (!validSignatures.some(sig => signature.includes(sig))) {
        // Additional check for other video formats
        const hexSignature = buffer.toString('hex', 0, 4);
        const validHexSignatures = ['000001ba', '000001b3', '1a45dfa3']; // MPEG, Matroska
        
        if (!validHexSignatures.includes(hexSignature.toLowerCase())) {
          throw new Error('Downloaded file does not appear to be a valid video file (invalid signature)');
        }
      }
      
      // Log successful validation
      const sizeInMB = Math.round(stats.size / 1024 / 1024 * 100) / 100;
      console.log(`[${processingId}] File validation passed - Size: ${sizeInMB}MB, Signature: ${signature || 'alt-format'}`);
      
    } catch (error) {
      console.error(`[${processingId}] Comprehensive file validation failed:`, error.message);
      
      // Try to remove the invalid file
      try {
        await fs.unlink(filePath);
      } catch (unlinkError) {
        console.error(`[${processingId}] Failed to remove invalid file:`, unlinkError.message);
      }
      
      throw new Error(`File validation failed: ${error.message}`);
    }
  }

  async cleanupFailedDownload(processingId) {
    try {
      const directories = [this.tempDir, this.outputDir];
      
      for (const dir of directories) {
        try {
          const files = await fs.readdir(dir);
          const tempFiles = files.filter(file => 
            file.includes(processingId) && 
            (file.includes('_original') || file.includes('.part') || file.includes('.tmp'))
          );

          for (const file of tempFiles) {
            try {
              await fs.unlink(path.join(dir, file));
              console.log(`[${processingId}] Cleaned up failed download file: ${file}`);
            } catch (unlinkError) {
              // Ignore individual file cleanup errors
            }
          }
        } catch (readError) {
          // Ignore directory read errors
        }
      }
    } catch (error) {
      console.error(`[${processingId}] Failed download cleanup error:`, error);
    }
  }

  // Enhanced versions of other methods...
  async getVideoInfoYoutubeDlEnhanced(videoUrl, processingId) {
    try {
      const userAgent = this.getRandomUserAgent();
      const sessionId = this.generateRandomSessionId();
      
      const info = await youtubedl(videoUrl, {
        dumpSingleJson: true,
        noCheckCertificate: true,
        noWarnings: true,
        preferFreeFormats: true,
        userAgent: userAgent,
        addHeader: [
          `User-Agent:${userAgent}`,
          'Accept-Language:en-US,en;q=0.9',
          'Accept-Encoding:gzip, deflate, br',
          'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Connection:keep-alive',
          'Cache-Control:no-cache',
          `X-Session-ID:${sessionId}`,
          'DNT:1'
        ],
        referer: 'https://www.youtube.com/',
        extractor: 'youtube',
        youtubeSkipDashManifest: true,
        geoBypass: true,
        geoBypassCountry: 'US',
        sleep: Math.floor(Math.random() * 2) + 1 // 1-2 seconds
      });
      
      return {
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
      };
    } catch (error) {
      throw new Error(`youtube-dl-exec enhanced getInfo failed: ${error.message}`);
    }
  }

  async createShortsWithSmartSegmentation(originalVideoPath, options) {
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
    
    console.log(`[${processing_id}] Creating ${numShorts} shorts from ${video_duration}s video with smart segmentation`);
    
    // Smart segmentation: avoid cutting in the middle of likely sentences/scenes
    const shorts = [];
    const totalUsableDuration = video_duration - segmentDuration;
    const segmentSpacing = totalUsableDuration / Math.max(1, numShorts - 1);
    
    for (let i = 0; i < numShorts; i++) {
      let startTime;
      
      if (i === 0) {
        startTime = 0; // First segment always starts at beginning
      } else if (i === numShorts - 1 && video_duration > segmentDuration * 2) {
        startTime = Math.max(0, video_duration - segmentDuration); // Last segment from the end
      } else {
        startTime = Math.floor(i * segmentSpacing);
        
        // Add small random offset to avoid repetitive cuts
        const randomOffset = Math.floor(Math.random() * 10) - 5; // ±5 seconds
        startTime = Math.max(0, Math.min(startTime + randomOffset, video_duration - segmentDuration));
      }
      
      const actualDuration = Math.min(segmentDuration, video_duration - startTime);
      
      if (actualDuration < 30) continue; // Skip segments shorter than 30 seconds
      
      const shortId = `short_${processing_id}_${i + 1}`;
      const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
      
      await this.extractSegmentEnhanced(originalVideoPath, shortPath, startTime, actualDuration, subscription_type);
      
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

  async extractSegmentEnhanced(inputPath, outputPath, startTime, duration, subscriptionType) {
    return new Promise((resolve, reject) => {
      const quality = subscriptionType === 'free' ? '720p' : '1080p';
      const resolution = quality === '720p' ? '1280x720' : '1920x1080';
      const videoBitrate = quality === '720p' ? '2500k' : '5000k'; // Increased bitrate
      const audioBitrate = '128k';
      
      let filterComplex = [];
      
      // Scale and pad to maintain aspect ratio
      filterComplex.push(`scale=${resolution.split('x')[0]}:${resolution.split('x')[1]}:force_original_aspect_ratio=decrease`);
      filterComplex.push(`pad=${resolution.split('x')[0]}:${resolution.split('x')[1]}:(ow-iw)/2:(oh-ih)/2:black`);
      
      // Add watermark for free users
      if (subscriptionType === 'free') {
        filterComplex.push(`drawtext=text='@VideoShortsBot':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.6:boxborderw=8:x=20:y=H-th-20`);
      }
      
      const filterString = filterComplex.join(',');
      
      let command = ffmpeg(inputPath)
        .seekInput(startTime)
        .duration(duration)
        .videoCodec('libx264')
        .audioCodec('aac')
        .videoBitrate(videoBitrate)
        .audioBitrate(audioBitrate)
        .format('mp4')
        .outputOptions([
          '-preset medium', // Better quality than 'fast'
          '-crf 20', // Better quality than 23
          '-movflags +faststart',
          '-pix_fmt yuv420p',
          '-profile:v main',
          '-level 4.0',
          '-maxrate ' + videoBitrate,
          '-bufsize ' + (parseInt(videoBitrate) * 2) + 'k',
          `-vf ${filterString}`,
          '-avoid_negative_ts make_zero',
          '-fflags +genpts'
        ]);
      
      const timeout = setTimeout(() => {
        command.kill('SIGKILL');
        reject(new Error(`FFmpeg timeout after 5 minutes processing segment at ${startTime}s`));
      }, 300000); // 5 minute timeout
      
      command
        .on('start', (cmd) => {
          console.log(`Starting enhanced ffmpeg: ${cmd.substring(0, 200)}...`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`Enhanced processing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          clearTimeout(timeout);
          console.log(`Enhanced segment extraction completed: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          clearTimeout(timeout);
          console.error(`Enhanced FFmpeg error: ${error.message}`);
          reject(new Error(`Enhanced video processing failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async generateThumbnailsWithFallback(shorts, processingId) {
    for (const short of shorts) {
      const thumbnailPath = path.join(
        this.outputDir,
        `${short.short_id}_thumbnail.jpg`
      );
      
      try {
        // Try multiple timestamp positions for better thumbnails
        const timestamps = [5, 10, 15, short.duration * 0.3, short.duration * 0.5];
        let thumbnailGenerated = false;
        
        for (const timestamp of timestamps) {
          if (timestamp >= short.duration - 2) continue; // Skip if too close to end
          
          try {
            await this.extractThumbnailAtTimestamp(short.local_path, thumbnailPath, timestamp);
            thumbnailGenerated = true;
            break;
          } catch (timestampError) {
            console.warn(`[${processingId}] Thumbnail extraction failed at ${timestamp}s for ${short.short_id}`);
            continue;
          }
        }
        
        if (!thumbnailGenerated) {
          throw new Error('All thumbnail extraction attempts failed');
        }
        
        short.thumbnail_path = thumbnailPath;
        
        // Get thumbnail file size
        const stats = await fs.stat(thumbnailPath);
        short.thumbnail_size = stats.size;
        
        console.log(`[${processingId}] Generated thumbnail for ${short.short_id}`);
        
      } catch (error) {
        console.error(`[${processingId}] Failed to generate thumbnail for ${short.short_id}:`, error);
        short.thumbnail_path = null; // Will use default thumbnail
      }
    }
    
    return shorts;
  }

  async extractThumbnailAtTimestamp(videoPath, thumbnailPath, timestamp) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Thumbnail extraction timeout'));
      }, 30000); // 30 second timeout
      
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .size('854x480') // Better thumbnail resolution
        .format('image2')
        .outputOptions([
          '-q:v 1', // Highest quality JPEG
          '-update 1',
          '-vf scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2:black'
        ])
        .on('end', () => {
          clearTimeout(timeout);
          resolve();
        })
        .on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        })
        .save(thumbnailPath);
    });
  }

  async uploadToStorageWithRetry(shorts, supabase, processingId) {
    const uploadedShorts = [];
    const maxRetries = 3;
    
    for (const short of shorts) {
      let uploaded = false;
      let lastError;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[${processingId}] Uploading ${short.short_id} to storage (attempt ${attempt}/${maxRetries})...`);
          
          // Upload video file with retry logic
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
            if (videoError.message.includes('already exists')) {
              // If file already exists, try with a unique suffix
              const uniqueVideoKey = `shorts/${processingId}/${short.short_id}_${Date.now()}.mp4`;
              const { error: retryVideoError } = await supabase.storage
                .from('processed-shorts')
                .upload(uniqueVideoKey, videoBuffer, {
                  contentType: 'video/mp4',
                  cacheControl: '3600',
                  upsert: false
                });
              
              if (retryVideoError) throw retryVideoError;
              videoKey = uniqueVideoKey;
            } else {
              throw videoError;
            }
          }
          
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
                  upsert: true // Allow overwrite for thumbnails
                });
              
              if (!thumbnailError) {
                const { data: { publicUrl } } = supabase.storage
                  .from('thumbnails')
                  .getPublicUrl(thumbnailKey);
                
                thumbnailUrl = publicUrl;
                thumbnailStoragePath = thumbnailKey;
              }
            } catch (thumbError) {
              console.warn(`[${processingId}] Failed to upload thumbnail for ${short.short_id}:`, thumbError);
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
          
          console.log(`[${processingId}] Successfully uploaded ${short.short_id} on attempt ${attempt}`);
          uploaded = true;
          break;
          
        } catch (error) {
          lastError = error;
          console.error(`[${processingId}] Upload attempt ${attempt} failed for ${short.short_id}:`, error.message);
          
          if (attempt < maxRetries) {
            const waitTime = 2000 * attempt; // Exponential backoff
            console.log(`[${processingId}] Waiting ${waitTime}ms before retry...`);
            await this.sleep(waitTime);
          }
        }
      }
      
      if (!uploaded) {
        console.error(`[${processingId}] Failed to upload ${short.short_id} after ${maxRetries} attempts: ${lastError.message}`);
        // Continue with other shorts even if one fails
      }
    }
    
    if (uploadedShorts.length === 0) {
      throw new Error('Failed to upload any shorts to storage after multiple attempts');
    }
    
    console.log(`[${processingId}] Successfully uploaded ${uploadedShorts.length}/${shorts.length} shorts`);
    return uploadedShorts;
  }

  async ensureDirectories() {
    const dirs = [this.tempDir, this.outputDir];
    
    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
        console.log(`Ensured directory exists: ${dir}`);
      } catch (error) {
        console.error(`Failed to create directory ${dir}:`, error);
        throw new Error(`Failed to create required directory: ${dir}`);
      }
    }
  }

  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
      /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
      /^([a-zA-Z0-9_-]{11})$/ // Direct video ID
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        // Validate video ID format (11 characters, alphanumeric + _ -)
        const videoId = match[1];
        if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          return videoId;
        }
      }
    }
    
    return null;
  }

  // Enhanced versions of the remaining methods...
  async getVideoInfoDistubeEnhanced(videoUrl, processingId) {
    try {
      const userAgent = this.getRandomUserAgent();
      const sessionId = this.generateRandomSessionId();
      
      const agent = ytdlDistube.createAgent(JSON.parse('[]'), {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept': '*/*',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
          'X-Session-ID': sessionId,
          'DNT': '1'
        }
      });
      
      const info = await ytdlDistube.getInfo(videoUrl, { 
        agent,
        requestOptions: {
          timeout: 30000
        }
      });
      
      return this.extractVideoDetails(info.videoDetails);
    } catch (error) {
      throw new Error(`Distube enhanced getInfo failed: ${error.message}`);
    }
  }

  async getVideoInfoYtdlCoreEnhanced(videoUrl, processingId) {
    try {
      const userAgent = this.getRandomUserAgent();
      
      const info = await ytdl.getInfo(videoUrl, {
        requestOptions: {
          headers: {
            'User-Agent': userAgent,
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'DNT': '1'
          },
          timeout: 30000
        }
      });
      
      return this.extractVideoDetails(info.videoDetails);
    } catch (error) {
      throw new Error(`ytdl-core enhanced getInfo failed: ${error.message}`);
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
    
    if (videoDetails.isLiveContent && videoDetails.isLive) {
      throw new Error('Cannot process live streams');
    }
    
    return {
      title: videoDetails.title || 'Unknown Title',
      description: videoDetails.shortDescription?.substring(0, 500) || '',
      author: videoDetails.author?.name || videoDetails.ownerChannelName || 'Unknown',
      duration: parseInt(videoDetails.lengthSeconds) || 0,
      view_count: parseInt(videoDetails.viewCount) || 0,
      upload_date: videoDetails.publishDate || videoDetails.uploadDate,
      video_id: videoDetails.videoId,
      thumbnail: videoDetails.thumbnails?.[0]?.url,
      is_live: videoDetails.isLiveContent,
      category: videoDetails.category
    };
  }

  async downloadWithDistubeEnhanced(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    const userAgent = this.getRandomUserAgent();
    const sessionId = this.generateRandomSessionId();
    
    return new Promise((resolve, reject) => {
      const timeoutMs = 600000; // 10 minutes
      let timeoutHandle;
      
      try {
        console.log(`[${processingId}] Distube: Enhanced download starting`);
        
        const agent = ytdlDistube.createAgent(JSON.parse('[]'), {
          headers: {
            'User-Agent': userAgent,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': '*/*',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',
            'X-Session-ID': sessionId,
            'DNT': '1'
          }
        });

        const stream = ytdlDistube(videoUrl, {
          quality: 'highestvideo',
          filter: format => {
            return format.container === 'mp4' && 
                   format.hasVideo && 
                   format.hasAudio &&
                   !format.isLive &&
                   format.qualityLabel &&
                   parseInt(format.qualityLabel) <= 1080; // Max 1080p
          },
          agent: agent,
          requestOptions: {
            headers: {
              'User-Agent': userAgent,
              'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 30000
          }
        });
        
        const writeStream = require('fs').createWriteStream(outputPath);
        
        timeoutHandle = setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('Enhanced download timeout - video might be too large or connection is slow'));
        }, timeoutMs);
        
        let downloadedBytes = 0;
        
        stream.on('progress', (chunkLength, downloaded, total) => {
          downloadedBytes = downloaded;
          if (total && total > 0) {
            const percent = Math.round((downloaded / total) * 100);
            if (percent % 10 === 0) { // Log every 10%
              console.log(`[${processingId}] Distube download progress: ${percent}% (${Math.round(downloaded / 1024 / 1024)}MB)`);
            }
          }
        });
        
        stream.on('error', (error) => {
          clearTimeout(timeoutHandle);
          writeStream.destroy();
          
          if (this.isBotDetectionError(error)) {
            reject(new Error('YouTube bot detection triggered during enhanced download. Trying alternative method...'));
          } else if (this.isRateLimitError(error)) {
            reject(new Error('Rate limited during enhanced download. Will retry with backoff...'));
          } else {
            reject(error);
          }
        });
        
        writeStream.on('error', (error) => {
          clearTimeout(timeoutHandle);
          stream.destroy();
          reject(error);
        });
        
        writeStream.on('finish', () => {
          clearTimeout(timeoutHandle);
          console.log(`[${processingId}] Distube: Enhanced download completed (${Math.round(downloadedBytes / 1024 / 1024)}MB)`);
          resolve(outputPath);
        });
        
        stream.pipe(writeStream);
        
      } catch (error) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(error);
      }
    });
  }

  async downloadWithYtdlCoreEnhanced(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    const userAgent = this.getRandomUserAgent();
    
    return new Promise((resolve, reject) => {
      const timeoutMs = 600000; // 10 minutes
      let timeoutHandle;
      
      try {
        console.log(`[${processingId}] ytdl-core: Enhanced download starting`);
        
        const stream = ytdl(videoUrl, {
          quality: 'highest',
          filter: format => {
            return format.container === 'mp4' && 
                   format.hasVideo && 
                   format.hasAudio &&
                   !format.isLive &&
                   format.qualityLabel &&
                   parseInt(format.qualityLabel) <= 1080; // Max 1080p
          },
          requestOptions: {
            headers: {
              'User-Agent': userAgent,
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              'DNT': '1'
            },
            timeout: 30000
          }
        });
        
        const writeStream = require('fs').createWriteStream(outputPath);
        
        timeoutHandle = setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('Enhanced download timeout - video might be too large'));
        }, timeoutMs);
        
        let downloadedBytes = 0;
        
        stream.on('progress', (chunkLength, downloaded, total) => {
          downloadedBytes = downloaded;
          if (total && total > 0) {
            const percent = Math.round((downloaded / total) * 100);
            if (percent % 10 === 0) { // Log every 10%
              console.log(`[${processingId}] ytdl-core download progress: ${percent}% (${Math.round(downloaded / 1024 / 1024)}MB)`);
            }
          }
        });
        
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
          console.log(`[${processingId}] ytdl-core: Enhanced download completed (${Math.round(downloadedBytes / 1024 / 1024)}MB)`);
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
      const timeout = setTimeout(() => {
        reject(new Error('Metadata extraction timeout'));
      }, 30000);
      
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        clearTimeout(timeout);
        
        if (err) {
          reject(new Error(`Failed to read video metadata: ${err.message}`));
          return;
        }
        
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
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
          format: format.format_name,
          has_audio: !!audioStream,
          audio_codec: audioStream?.codec_name || 'none'
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
    
    if (metadata.duration < 60) {
      throw new Error('Video is too short. Minimum required: 60 seconds');
    }
    
    // Check file size limits
    const maxSizeMB = subscriptionType === 'free' ? 150 : 750; // Increased limits
    if (metadata.size_mb > maxSizeMB) {
      throw new Error(`Video file is too large. Maximum allowed: ${maxSizeMB}MB for ${subscriptionType} users`);
    }
    
    // Check resolution
    if (metadata.width < 480 || metadata.height < 360) {
      throw new Error('Video resolution is too low. Minimum required: 480x360');
    }
    
    // Check if video has audio
    if (!metadata.has_audio) {
      console.warn('Video has no audio stream, but proceeding with processing');
    }
    
    console.log(`Enhanced video validation passed - Duration: ${metadata.duration}s, Size: ${metadata.size_mb}MB, Resolution: ${metadata.width}x${metadata.height}, Audio: ${metadata.has_audio ? 'Yes' : 'No'}`);
  }

  async saveToDatabase(supabase, data) {
    try {
      // Save main processing record with enhanced metadata
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
            codec: data.metadata.codec,
            format: data.metadata.format,
            has_audio: data.metadata.has_audio,
            audio_codec: data.metadata.audio_codec
          },
          video_info: {
            title: data.video_info.title,
            author: data.video_info.author,
            duration: data.video_info.duration,
            view_count: data.video_info.view_count,
            upload_date: data.video_info.upload_date,
            video_id: data.video_info.video_id,
            category: data.video_info.category
          },
          shorts_count: data.shorts.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (processError) {
        console.error('Failed to save processing record:', processError);
        throw processError;
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
            thumbnail_storage_path: short.thumbnail_storage_path,
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
          // Don't throw error for individual shorts, just log
        }
      }

      console.log(`Successfully saved processing record and ${data.shorts.length} shorts to database`);

    } catch (error) {
      console.error('Enhanced database save error:', error);
      throw new Error(`Failed to save to database: ${error.message}`);
    }
  }

  async cleanup(processingId) {
    try {
      console.log(`[${processingId}] Starting enhanced cleanup of temporary files`);
      
      const directories = [this.tempDir, this.outputDir];
      let cleanedFiles = 0;
      let cleanedSize = 0;

      for (const dir of directories) {
        try {
          const files = await fs.readdir(dir);
          const tempFiles = files.filter(file => file.includes(processingId));

          for (const file of tempFiles) {
            try {
              const filePath = path.join(dir, file);
              const stats = await fs.stat(filePath);
              cleanedSize += stats.size;
              
              await fs.unlink(filePath);
              cleanedFiles++;
              console.log(`[${processingId}] Deleted: ${file} (${Math.round(stats.size / 1024 / 1024)}MB)`);
            } catch (unlinkError) {
              console.error(`[${processingId}] Failed to delete ${file}:`, unlinkError);
            }
          }
        } catch (readError) {
          console.error(`[${processingId}] Failed to read directory ${dir}:`, readError);
        }
      }

      const cleanedSizeMB = Math.round(cleanedSize / 1024 / 1024);
      console.log(`[${processingId}] Enhanced cleanup completed: ${cleanedFiles} files, ${cleanedSizeMB}MB freed`);
    } catch (error) {
      console.error(`[${processingId}] Enhanced cleanup error:`, error);
    }
  }

  enhanceError(error, processingId, videoUrl) {
    const message = error.message.toLowerCase();
    
    // Enhanced error classification
    if (this.isBotDetectionError(error)) {
      return new Error('YouTube has detected automated access and is blocking requests. This is temporary - please wait 10-15 minutes before trying again, or try a different video. Consider using videos from different channels or timeframes.');
    } else if (this.isRateLimitError(error)) {
      return new Error('Rate limited by YouTube due to high request volume. Please wait 5-10 minutes before trying again.');
    } else if (message.includes('video unavailable') || message.includes('private') || message.includes('removed')) {
      return new Error('This YouTube video is private, unavailable, or has been removed. Please verify the video is publicly accessible and try a different video.');
    } else if (message.includes('age-restricted') || message.includes('age_restricted')) {
      return new Error('This video is age-restricted and cannot be processed. Please try a different video that is not age-restricted.');
    } else if (message.includes('region') || message.includes('blocked') || message.includes('geo')) {
      return new Error('This video is not available in your region due to geographic restrictions. Please try a different video.');
    } else if (message.includes('timeout') || message.includes('network') || message.includes('connection')) {
      return new Error('Network timeout or connection issue occurred. Please check your internet connection and try again in a few minutes.');
    } else if (message.includes('too large') || message.includes('file size') || message.includes('exceeds')) {
      return new Error('Video file is too large for processing. Please try a shorter video or consider upgrading your subscription for higher limits.');
    } else if (message.includes('too long') || message.includes('duration') || message.includes('maximum')) {
      return new Error('Video is too long for processing. Please try a shorter video or consider upgrading your subscription for higher limits.');
    } else if (message.includes('too short') || message.includes('minimum')) {
      return new Error('Video is too short to create shorts. Videos must be at least 60 seconds long.');
    } else if (message.includes('invalid data') || message.includes('no video stream') || message.includes('corrupted')) {
      return new Error('The video file appears to be corrupted or in an unsupported format. This may be due to YouTube protection measures. Please try a different video.');
    } else if (message.includes('ffmpeg') || message.includes('encoding') || message.includes('codec')) {
      return new Error('Video processing failed due to encoding issues. The video format may not be fully supported. Please try a different video.');
    } else if (message.includes('download') || message.includes('fetch') || message.includes('retrieve')) {
      return new Error('Failed to download the video. Please verify the URL is correct and the video is publicly accessible.');
    } else if (message.includes('storage') || message.includes('upload') || message.includes('save')) {
      return new Error('Failed to save processed videos to cloud storage. Please try again or contact support if the problem persists.');
    } else if (message.includes('database') || message.includes('record')) {
      return new Error('Failed to save processing results to database. The videos were processed but not saved. Please contact support.');
    } else if (message.includes('permission') || message.includes('access') || message.includes('forbidden')) {
      return new Error('Access denied to video or storage resources. Please verify permissions and try again.');
    } else {
      // Return enhanced error with more context
      return new Error(`Video processing failed: ${error.message}. Processing ID: ${processingId}. Please try again with a different video or contact support if the issue persists.`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = EnhancedYouTubeProcessor;