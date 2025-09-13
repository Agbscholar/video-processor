// processors/youtube-processor.js - Enhanced with better anti-detection and robust fallbacks
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
    this.maxRetries = 5;
    this.retryDelay = 3000;
    
    // Updated user agents and browser fingerprints for 2025
    this.browserProfiles = [
      {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Win32',
        clientName: 'WEB',
        clientVersion: '2.20241201.09.00'
      },
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'MacIntel',
        clientName: 'WEB',
        clientVersion: '2.20241201.09.00'
      },
      {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Linux x86_64',
        clientName: 'WEB',
        clientVersion: '2.20241201.09.00'
      },
      {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'iPhone',
        clientName: 'IOS',
        clientVersion: '19.09.4'
      },
      {
        userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Android',
        clientName: 'ANDROID',
        clientVersion: '19.09.37'
      }
    ];

    // Enhanced rate limiting with intelligent backoff
    this.lastRequestTime = 0;
    this.minRequestInterval = 20000; // Increased to 20 seconds
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
    this.dailyRequestCount = 0;
    this.dailyRequestReset = Date.now();
    
    // Session and proxy management
    this.currentProfile = null;
    this.sessionRotationCount = 0;
    this.maxSessionRequests = 3;
    this.requestCount = 0;
    
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
          exec('python3 -m yt_dlp --version', (error2, stdout2) => {
            if (!error2 && stdout2) {
              console.log('yt-dlp (python) version:', stdout2.trim());
            }
            resolve(!error2);
          });
        }
      });
    });
  }

  async checkYoutubeDl() {
    return new Promise((resolve) => {
      exec('youtube-dl --version', (error, stdout) => {
        if (!error && stdout) {
          console.log('youtube-dl version:', stdout.trim());
        }
        resolve(!error);
      });
    });
  }

  getRandomBrowserProfile() {
    return this.browserProfiles[Math.floor(Math.random() * this.browserProfiles.length)];
  }

  async rotateSession() {
    this.currentProfile = this.getRandomBrowserProfile();
    this.sessionRotationCount++;
    this.requestCount = 0;
    
    // Add random delay to avoid pattern detection
    await this.sleep(2000 + Math.random() * 3000);
    
    console.log(`Session rotated to ${this.currentProfile.platform} (rotation #${this.sessionRotationCount})`);
  }

  async enforceIntelligentRateLimit() {
    const now = Date.now();
    
    // Reset daily counter if needed
    if (now - this.dailyRequestReset > 24 * 60 * 60 * 1000) {
      this.dailyRequestCount = 0;
      this.dailyRequestReset = now;
    }
    
    this.dailyRequestCount++;
    
    // Progressive backoff based on failures and daily usage
    let baseWaitTime = this.minRequestInterval;
    
    if (this.consecutiveFailures > 0) {
      baseWaitTime = Math.min(900000, baseWaitTime * Math.pow(3, this.consecutiveFailures)); // Max 15 minutes
    }
    
    // Additional delays based on daily usage
    if (this.dailyRequestCount > 10) {
      baseWaitTime += 30000; // Extra 30s after 10 daily requests
    }
    if (this.dailyRequestCount > 20) {
      baseWaitTime += 60000; // Extra 60s after 20 daily requests
    }
    
    // Session rotation check
    if (this.requestCount >= this.maxSessionRequests) {
      await this.rotateSession();
      baseWaitTime += 15000; // Extra delay after rotation
    }
    
    // Add intelligent jitter
    const jitter = Math.random() * Math.min(10000, baseWaitTime * 0.3);
    const totalWaitTime = baseWaitTime + jitter;
    
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < totalWaitTime) {
      const sleepTime = totalWaitTime - timeSinceLastRequest;
      console.log(`Intelligent rate limit: waiting ${Math.round(sleepTime/1000)}s (failures: ${this.consecutiveFailures}, daily: ${this.dailyRequestCount}, session: ${this.requestCount})`);
      await this.sleep(sleepTime);
    }
    
    this.lastRequestTime = Date.now();
    this.requestCount++;
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
    
    console.log(`[${processing_id}] Starting enhanced YouTube video processing with anti-detection`);
    
    if (!supabase_config?.url || !supabase_config?.service_key) {
      throw new Error('Missing Supabase configuration (url or service_key)');
    }
    
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    const startTime = Date.now();
    
    try {
      await this.ensureDirectories();
      await this.rotateSession(); // Start with fresh session
      
      console.log(`[${processing_id}] Validating YouTube URL`);
      const videoId = this.extractVideoId(video_url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL format');
      }
      
      console.log(`[${processing_id}] Extracted video ID: ${videoId}`);
      
      console.log(`[${processing_id}] Fetching video information with enhanced anti-detection`);
      const videoDetails = await this.getVideoInfoWithAntiDetection(video_url, processing_id);
      
      console.log(`[${processing_id}] Downloading video with enhanced anti-detection methods`);
      originalVideoPath = await this.downloadVideoWithAntiDetection(video_url, processing_id);
      
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
      console.error(`[${processing_id}] Enhanced YouTube processing failed:`, error);
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

  async getVideoInfoWithAntiDetection(videoUrl, processingId) {
    await this.enforceIntelligentRateLimit();

    const methods = [
      // Start with methods that don't trigger bot detection
      () => this.getVideoInfoViaOEmbed(videoUrl, processingId),
      () => this.getVideoInfoViaAlternativeAPI(videoUrl, processingId),
      
      // Advanced yt-dlp methods with anti-detection
      ...(this.availableTools.ytDlp ? [
        () => this.getVideoInfoWithYtDlpAdvanced(videoUrl, processingId, 'android_music'),
        () => this.getVideoInfoWithYtDlpAdvanced(videoUrl, processingId, 'android_creator'),
        () => this.getVideoInfoWithYtDlpAdvanced(videoUrl, processingId, 'ios_music'),
        () => this.getVideoInfoWithYtDlpAdvanced(videoUrl, processingId, 'tv_embedded'),
      ] : []),
      
      // Conservative ytdl-core approaches
      () => this.getVideoInfoWithYtdlCoreAdvanced(videoUrl, processingId, 'mobile'),
      () => this.getVideoInfoWithYtdlCoreAdvanced(videoUrl, processingId, 'minimal'),
      
      // Fallback
      () => this.getVideoInfoFallback(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying enhanced video info method ${index + 1}/${methods.length}`);
        const result = await method();
        console.log(`[${processingId}] Video info method ${index + 1} succeeded`);
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Video info method ${index + 1} failed: ${error.message}`);
        
        if (this.isCriticalError(error)) {
          console.log(`[${processingId}] Critical error detected, implementing extended backoff`);
          this.consecutiveFailures++;
          const backoffTime = this.calculateBackoffTime();
          await this.sleep(backoffTime);
          
          // Rotate session after critical errors
          if (this.consecutiveFailures >= 2) {
            await this.rotateSession();
          }
        } else if (index < methods.length - 1) {
          await this.sleep(3000 + Math.random() * 4000);
        }
      }
    }
    
    throw new Error(`All enhanced video info methods failed: ${lastError.message}`);
  }

  calculateBackoffTime() {
    const baseBackoff = 60000; // 1 minute base
    const maxBackoff = 1800000; // 30 minutes max
    const exponentialFactor = Math.pow(2, this.consecutiveFailures - 1);
    const jitter = Math.random() * 0.3 + 0.7; // 70-100% of calculated time
    
    return Math.min(maxBackoff, baseBackoff * exponentialFactor * jitter);
  }

  async getVideoInfoWithYtDlpAdvanced(videoUrl, processingId, clientType = 'android_music') {
    if (!this.currentProfile) {
      await this.rotateSession();
    }

    const profile = this.currentProfile;
    let baseOptions = [
      '--dump-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificate',
      '--socket-timeout', '30',
      '--retries', '1',
      '--user-agent', profile.userAgent
    ];

    // Advanced client configurations to bypass detection
    const clientConfigs = {
      'android_music': ['--extractor-args', 'youtube:player_client=android_music'],
      'android_creator': ['--extractor-args', 'youtube:player_client=android_creator'],
      'ios_music': ['--extractor-args', 'youtube:player_client=ios_music'],
      'tv_embedded': ['--extractor-args', 'youtube:player_client=tv_embedded'],
      'mediaconnect': ['--extractor-args', 'youtube:player_client=mediaconnect']
    };

    if (clientConfigs[clientType]) {
      baseOptions.push(...clientConfigs[clientType]);
    }

    baseOptions.push(videoUrl);
    
    const commands = ['yt-dlp', 'python3 -m yt_dlp'];
    
    for (const cmd of commands) {
      try {
        return await this.executeYtDlpCommandAdvanced(cmd, baseOptions, processingId, clientType);
      } catch (error) {
        console.warn(`Command ${cmd} (${clientType}) failed:`, error.message);
        continue;
      }
    }
    
    throw new Error(`yt-dlp advanced (${clientType}) not available or failed`);
  }

  async executeYtDlpCommandAdvanced(baseCmd, options, processingId, clientType) {
    const fullCommand = baseCmd === 'yt-dlp' ? [baseCmd, ...options] : 
                       ['python3', '-m', 'yt_dlp', ...options];

    return new Promise((resolve, reject) => {
      const process = spawn(fullCommand[0], fullCommand.slice(1));
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
          reject(new Error(`Command failed (code ${code}): ${errorMsg}`));
        }
      });

      setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error('Video info request timeout'));
      }, 60000); // 1 minute timeout
    });
  }

  async getVideoInfoWithYtdlCoreAdvanced(videoUrl, processingId, mode = 'mobile') {
    if (!this.currentProfile) {
      await this.rotateSession();
    }

    const profile = this.currentProfile;

    try {
      const options = {
        requestOptions: {
          timeout: 45000,
          headers: {
            'User-Agent': profile.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': profile.acceptLanguage,
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0'
          }
        }
      };

      // Mode-specific configurations
      if (mode === 'mobile') {
        options.requestOptions.headers['Sec-Ch-Ua-Mobile'] = '?1';
        options.requestOptions.headers['Sec-Ch-Ua-Platform'] = '"Android"';
      } else if (mode === 'minimal') {
        // Minimal headers to avoid fingerprinting
        options.requestOptions.headers = {
          'User-Agent': profile.userAgent,
          'Accept-Language': profile.acceptLanguage
        };
      }

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
      throw new Error(`ytdl-core advanced (${mode}) failed: ${error.message}`);
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
        timeout: 20000,
        headers: {
          'User-Agent': this.currentProfile?.userAgent || this.getRandomBrowserProfile().userAgent,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        httpsAgent: new https.Agent({
          rejectUnauthorized: false,
          keepAlive: true
        })
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

  async getVideoInfoViaAlternativeAPI(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID');
    }

    try {
      // Use YouTube's basic info endpoint that's less protected
      const infoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      
      const response = await axios.get(infoUrl, {
        timeout: 25000,
        headers: {
          'User-Agent': this.currentProfile?.userAgent || this.getRandomBrowserProfile().userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        maxRedirects: 3
      });

      const html = response.data;
      
      // Extract basic info from page HTML
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].replace(' - YouTube', '') : `Video ${videoId}`;
      
      return {
        title: title,
        description: 'Retrieved via alternative method',
        author: 'Unknown',
        duration: 0,
        view_count: 0,
        upload_date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
        video_id: videoId,
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        is_live: false,
        category: 'Unknown'
      };
    } catch (error) {
      throw new Error(`Alternative API method failed: ${error.message}`);
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

  async downloadVideoWithAntiDetection(videoUrl, processingId) {
    const methods = [
      // Prioritize methods with best anti-detection
      ...(this.availableTools.ytDlp ? [
        () => this.downloadWithYtDlpAdvanced(videoUrl, processingId, 'android_music'),
        () => this.downloadWithYtDlpAdvanced(videoUrl, processingId, 'ios_music'),
        () => this.downloadWithYtDlpAdvanced(videoUrl, processingId, 'tv_embedded'),
        () => this.downloadWithYtDlpAdvanced(videoUrl, processingId, 'android_creator'),
        () => this.downloadWithYtDlpAdvanced(videoUrl, processingId, 'mediaconnect'),
      ] : []),
      
      // Conservative ytdl-core approaches
      () => this.downloadWithYtdlCoreAdvanced(videoUrl, processingId, 'mobile'),
      () => this.downloadWithYtdlCoreAdvanced(videoUrl, processingId, 'minimal_headers'),
      () => this.downloadWithYtdlCoreAdvanced(videoUrl, processingId, 'audio_first'),
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying enhanced download method ${index + 1}/${methods.length}`);
        await this.enforceIntelligentRateLimit();
        
        const result = await method();
        console.log(`[${processingId}] Download method ${index + 1} succeeded`);
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Download method ${index + 1} failed: ${error.message}`);
        
        await this.cleanupFailedDownload(processingId);
        
        if (this.isCriticalError(error)) {
          this.consecutiveFailures++;
          const backoffTime = this.calculateBackoffTime();
          
          console.log(`[${processingId}] Critical error detected, backing off for ${Math.round(backoffTime/1000)}s`);
          await this.sleep(backoffTime);
          
          // Force session rotation after critical errors
          if (this.consecutiveFailures >= 2) {
            await this.rotateSession();
          }
        } else if (index < methods.length - 1) {
          await this.sleep(5000 + Math.random() * 5000);
        }
      }
    }
    
    throw new Error(`All enhanced download methods failed. Last error: ${lastError.message}`);
  }

  async downloadWithYtDlpAdvanced(videoUrl, processingId, clientType = 'android_music') {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    
    if (!this.currentProfile) {
      await this.rotateSession();
    }
    
    const profile = this.currentProfile;
    
    let baseOptions = [
      '--output', outputTemplate,
      '--format', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--no-call-home',
      '--socket-timeout', '45',
      '--retries', '1',
      '--fragment-retries', '1',
      '--limit-rate', '1M',
      '--user-agent', profile.userAgent,
      '--add-header', `Accept-Language:${profile.acceptLanguage}`
    ];

    // Advanced client configurations
    const clientConfigs = {
      'android_music': ['--extractor-args', 'youtube:player_client=android_music'],
      'ios_music': ['--extractor-args', 'youtube:player_client=ios_music'],
      'tv_embedded': ['--extractor-args', 'youtube:player_client=tv_embedded'],
      'android_creator': ['--extractor-args', 'youtube:player_client=android_creator'],
      'mediaconnect': ['--extractor-args', 'youtube:player_client=mediaconnect']
    };

    if (clientConfigs[clientType]) {
      baseOptions.push(...clientConfigs[clientType]);
    }

    // Additional anti-detection measures
    baseOptions.push('--sleep-interval', '2', '--max-sleep-interval', '5');

    baseOptions.push(videoUrl);
    
    const commands = ['yt-dlp', 'python3 -m yt_dlp'];
    
    for (const cmd of commands) {
      try {
        return await this.executeDownloadCommandAdvanced(cmd, baseOptions, processingId, clientType);
      } catch (error) {
        console.warn(`Download with ${cmd} (${clientType}) failed:`, error.message);
        continue;
      }
    }
    
    throw new Error(`yt-dlp advanced download (${clientType}) failed`);
  }

  async executeDownloadCommandAdvanced(baseCmd, options, processingId, clientType) {
    const fullCommand = baseCmd === 'yt-dlp' ? [baseCmd, ...options] : 
                       ['python3', '-m', 'yt_dlp', ...options];

    return new Promise((resolve, reject) => {
      const process = spawn(fullCommand[0], fullCommand.slice(1));
      let stderr = '';
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        const progress = data.toString();
        if (progress.includes('%') && !progress.includes('ERROR')) {
          console.log(`[${processingId}] Download (${clientType}): ${progress.trim()}`);
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
            console.log(`[${processingId}] Download completed (${clientType}): ${outputFile}`);
            resolve(filePath);
          } catch (error) {
            reject(new Error(`Failed to locate downloaded file: ${error.message}`));
          }
        } else {
          const errorMsg = stderr || 'Unknown download error';
          reject(new Error(`Download failed (code ${code}): ${errorMsg}`));
        }
      });

      setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error('Download timeout'));
      }, 900000); // 15 minutes timeout for large files
    });
  }

  async downloadWithYtdlCoreAdvanced(videoUrl, processingId, mode = 'mobile') {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    if (!this.currentProfile) {
      await this.rotateSession();
    }

    const profile = this.currentProfile;
    
    return new Promise((resolve, reject) => {
      try {
        let options = {
          requestOptions: {
            timeout: 60000,
            headers: {
              'User-Agent': profile.userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': profile.acceptLanguage,
              'Accept-Encoding': 'gzip, deflate',
              'DNT': '1',
              'Connection': 'keep-alive',
              'Upgrade-Insecure-Requests': '1'
            }
          }
        };

        // Mode-specific configurations
        switch (mode) {
          case 'mobile':
            options.quality = 'highestvideo';
            options.filter = 'audioandvideo';
            options.requestOptions.headers['Sec-Ch-Ua-Mobile'] = '?1';
            options.requestOptions.headers['Sec-Ch-Ua-Platform'] = '"Android"';
            break;
            
          case 'minimal_headers':
            options.quality = 'highestvideo';
            options.filter = 'audioandvideo';
            options.requestOptions.headers = {
              'User-Agent': profile.userAgent,
              'Accept-Language': profile.acceptLanguage
            };
            break;
            
          case 'audio_first':
            options.quality = 'highest';
            options.filter = 'audioandvideo';
            break;
            
          default:
            options.quality = 'highestvideo';
            options.filter = 'audioandvideo';
        }

        const stream = ytdl(videoUrl, options);
        const writeStream = fsSync.createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        let lastProgress = 0;
        stream.on('progress', (chunkLength, downloaded, total) => {
          if (total > 0) {
            const percent = (downloaded / total * 100);
            if (percent - lastProgress > 10) {
              console.log(`[${processingId}] ytdl-core (${mode}) download: ${percent.toFixed(1)}%`);
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
        
        // Longer timeout for ytdl-core
        setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('Download timeout'));
        }, 1200000); // 20 minutes timeout
        
      } catch (error) {
        reject(new Error(`ytdl-core setup failed: ${error.message}`));
      }
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

  isCriticalError(error) {
    const errorMsg = error.message.toLowerCase();
    return errorMsg.includes('410') || 
           errorMsg.includes('403') ||
           errorMsg.includes('429') ||
           errorMsg.includes('sign in to confirm') || 
           errorMsg.includes('bot') || 
           errorMsg.includes('verify') ||
           errorMsg.includes('captcha') ||
           errorMsg.includes('blocked') ||
           errorMsg.includes('too many requests') ||
           errorMsg.includes('quota exceeded') ||
           errorMsg.includes('unavailable') ||
           errorMsg.includes('identity token') ||
           errorMsg.includes('private video') ||
           errorMsg.includes('members-only') ||
           errorMsg.includes('age-restricted');
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

      // Check file header for valid video format
      const buffer = await fs.readFile(filePath, { start: 0, end: 100 });
      const header = buffer.toString('hex');
      
      const videoSignatures = [
        '00000018667479704d503431', // MP4
        '00000020667479704d503432', // MP4
        '1a45dfa3', // WebM
        '464c5601', // FLV
        'ftyp', // General MP4
        'moov' // QuickTime/MP4
      ];
      
      const isVideoFile = videoSignatures.some(sig => header.includes(sig));
      
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
    
    if (message.includes('410') || message.includes('bot') || message.includes('sign in to confirm') || message.includes('identity token')) {
      return new Error('YouTube has temporarily blocked access due to automated detection. This usually resolves within 1-2 hours. Please try again later or try a different video.');
    } else if (message.includes('video unavailable') || message.includes('private')) {
      return new Error('This YouTube video is private, unavailable, or has been deleted. Please verify the URL and try a different video.');
    } else if (message.includes('age-restricted') || message.includes('age_restricted')) {
      return new Error('This video is age-restricted and cannot be processed. Please try a different video.');
    } else if (message.includes('region') || message.includes('blocked')) {
      return new Error('This video is not available in your region. Please try a different video.');
    } else if (message.includes('all enhanced download methods failed') || message.includes('all download methods failed')) {
      return new Error('Unable to download this video due to YouTube restrictions. This may be temporary - please try again in 30-60 minutes, or try a different video.');
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
      return new Error(`Video processing failed: ${error.message}. If this persists, please try again later or contact support.`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = YouTubeProcessor;