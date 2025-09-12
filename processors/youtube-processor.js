// processors/youtube-processor.js - Enhanced with comprehensive anti-detection and fallback methods
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

class YouTubeProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 5;
    this.retryDelay = 3000;
    
    // Enhanced and more recent user agents
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Android 14; Mobile; rv:123.0) Gecko/123.0 Firefox/123.0'
    ];

    // Enhanced rate limiting with exponential backoff
    this.lastRequestTime = 0;
    this.minRequestInterval = 8000;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 4;
    
    // Session management for better anti-detection
    this.sessionCookies = new Map();
    this.requestCount = 0;
    this.sessionStartTime = Date.now();
    
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

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    let waitTime = this.minRequestInterval;
    if (this.consecutiveFailures > 0) {
      waitTime = Math.min(120000, this.minRequestInterval * Math.pow(2, this.consecutiveFailures));
    }
    
    this.requestCount++;
    if (this.requestCount > 10) {
      waitTime += 15000;
    }
    
    if (timeSinceLastRequest < waitTime) {
      const sleepTime = waitTime - timeSinceLastRequest;
      console.log(`Rate limiting: waiting ${sleepTime}ms (failures: ${this.consecutiveFailures}, requests: ${this.requestCount})`);
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
    
    console.log(`[${processing_id}] Starting enhanced YouTube video processing`);
    
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
      
      console.log(`[${processing_id}] Extracted video ID: ${videoId}`);
      
      console.log(`[${processing_id}] Fetching video information with enhanced fallback system`);
      const videoDetails = await this.getVideoInfoWithImprovedFallback(video_url, processing_id);
      
      console.log(`[${processing_id}] Downloading video with comprehensive fallback methods`);
      originalVideoPath = await this.downloadVideoWithImprovedFallbacks(video_url, processing_id);
      
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

  async getVideoInfoWithImprovedFallback(videoUrl, processingId) {
    await this.enforceRateLimit();

    const methods = [];
    
    if (this.availableTools.ytDlp) {
      methods.push(() => this.getVideoInfoWithYtDlp(videoUrl, processingId, 'standard'));
      methods.push(() => this.getVideoInfoWithYtDlp(videoUrl, processingId, 'embedded'));
      methods.push(() => this.getVideoInfoWithYtDlp(videoUrl, processingId, 'mobile'));
    }
    
    if (this.availableTools.youtubeDl) {
      methods.push(() => this.getVideoInfoWithYoutubeDl(videoUrl, processingId));
    }
    
    methods.push(() => this.getVideoInfoWithYtdlCore(videoUrl, processingId, 'default'));
    methods.push(() => this.getVideoInfoWithYtdlCore(videoUrl, processingId, 'embedded'));
    methods.push(() => this.getVideoInfoViaAPI(videoUrl, processingId));
    methods.push(() => this.getVideoInfoFallbackMethod(videoUrl, processingId));

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying video info method ${index + 1}/${methods.length}`);
        const result = await method();
        console.log(`[${processingId}] Video info method ${index + 1} succeeded`);
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Video info method ${index + 1} failed: ${error.message}`);
        
        if (this.isBotDetectionError(error) || this.isRateLimitError(error)) {
          console.log(`[${processingId}] Detected bot blocking/rate limiting, increasing backoff`);
          this.consecutiveFailures++;
          const backoffTime = Math.min(60000, 10000 * Math.pow(2, this.consecutiveFailures));
          await this.sleep(backoffTime);
        } else if (index < methods.length - 1) {
          await this.sleep(2000 + Math.random() * 3000);
        }
      }
    }
    
    throw new Error(`All video info methods failed: ${lastError.message}`);
  }

  async getVideoInfoWithYtDlp(videoUrl, processingId, mode = 'standard') {
    const userAgent = this.getRandomUserAgent();
    let baseOptions = [
      '--dump-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificate',
      '--prefer-free-formats',
      '--user-agent', userAgent,
      '--referer', 'https://www.google.com/'
    ];

    switch (mode) {
      case 'embedded':
        baseOptions.push('--extractor-args', 'youtube:player_client=web_embedded');
        break;
      case 'mobile':
        baseOptions.push('--extractor-args', 'youtube:player_client=android');
        break;
      case 'standard':
      default:
        baseOptions.push('--extractor-args', 'youtube:player_client=web');
        break;
    }

    baseOptions.push(videoUrl);
    
    const commands = ['yt-dlp', 'python3 -m yt_dlp'];
    
    for (const cmd of commands) {
      try {
        return await this.executeYtDlpCommand(cmd, baseOptions, processingId);
      } catch (error) {
        console.warn(`Command ${cmd} (${mode}) failed:`, error.message);
        continue;
      }
    }
    
    throw new Error(`yt-dlp (${mode}) not available or failed`);
  }

  async executeYtDlpCommand(baseCmd, options, processingId) {
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
      }, 45000);
    });
  }

  async getVideoInfoWithYoutubeDl(videoUrl, processingId) {
    try {
      const result = await youtubedl(videoUrl, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        format: 'best[height<=720]'
      });
      
      return {
        title: result.title || 'Unknown Title',
        description: (result.description || '').substring(0, 500),
        author: result.uploader || result.channel || 'Unknown',
        duration: parseInt(result.duration) || 0,
        view_count: parseInt(result.view_count) || 0,
        upload_date: result.upload_date,
        video_id: result.id,
        thumbnail: result.thumbnail,
        is_live: result.is_live || false,
        category: result.categories?.[0] || 'Unknown'
      };
    } catch (error) {
      throw new Error(`youtube-dl failed: ${error.message}`);
    }
  }

  async getVideoInfoWithYtdlCore(videoUrl, processingId, mode = 'default') {
    try {
      const options = {
        requestOptions: {
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
          }
        }
      };

      if (mode === 'embedded') {
        options.requestOptions.headers['Referer'] = 'https://www.youtube.com/';
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
      throw new Error(`ytdl-core (${mode}) failed: ${error.message}`);
    }
  }

  async getVideoInfoViaAPI(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID for API method');
    }

    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      
      const response = await axios.get(oembedUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'application/json',
          'Referer': 'https://www.google.com/'
        }
      });

      const data = response.data;
      
      return {
        title: data.title || 'Unknown Title',
        description: 'Retrieved via API fallback method',
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
      throw new Error(`API fallback method failed: ${error.message}`);
    }
  }

  async getVideoInfoFallbackMethod(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID');
    }

    return {
      title: `YouTube Video ${videoId}`,
      description: 'Video processing in progress',
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

  async downloadVideoWithImprovedFallbacks(videoUrl, processingId) {
    const methods = [];
    
    if (this.availableTools.ytDlp) {
      methods.push(() => this.downloadWithYtDlp(videoUrl, processingId, 'standard'));
      methods.push(() => this.downloadWithYtDlp(videoUrl, processingId, 'embedded'));
      methods.push(() => this.downloadWithYtDlp(videoUrl, processingId, 'mobile'));
      methods.push(() => this.downloadWithYtDlp(videoUrl, processingId, 'fallback'));
    }
    
    if (this.availableTools.youtubeDl) {
      methods.push(() => this.downloadWithYoutubeDl(videoUrl, processingId));
    }
    
    methods.push(() => this.downloadWithYtdlCore(videoUrl, processingId, 'default'));
    methods.push(() => this.downloadWithYtdlCore(videoUrl, processingId, 'fallback'));

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Trying download method ${index + 1}/${methods.length}`);
        await this.enforceRateLimit();
        
        const result = await method();
        console.log(`[${processingId}] Download method ${index + 1} succeeded`);
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Download method ${index + 1} failed: ${error.message}`);
        
        await this.cleanupFailedDownload(processingId);
        
        if (this.isBotDetectionError(error) || this.isRateLimitError(error)) {
          this.consecutiveFailures++;
          const backoffTime = Math.min(90000, 15000 * Math.pow(2, this.consecutiveFailures));
          console.log(`[${processingId}] Bot detection/rate limit, backing off for ${backoffTime}ms`);
          await this.sleep(backoffTime);
        } else if (index < methods.length - 1) {
          await this.sleep(5000 + Math.random() * 5000);
        }
      }
    }
    
    throw new Error(`All download methods failed. Last error: ${lastError.message}`);
  }

  async downloadWithYtDlp(videoUrl, processingId, mode = 'standard') {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    const userAgent = this.getRandomUserAgent();
    
    let baseOptions = [
      '--output', outputTemplate,
      '--format', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--user-agent', userAgent,
      '--referer', 'https://www.youtube.com/',
      '--retries', '3',
      '--fragment-retries', '3',
      '--limit-rate', '1.5M',
      '--throttled-rate', '100K'
    ];

    switch (mode) {
      case 'embedded':
        baseOptions.push('--extractor-args', 'youtube:player_client=web_embedded');
        break;
      case 'mobile':
        baseOptions.push('--extractor-args', 'youtube:player_client=android');
        baseOptions.push('--format', 'best[height<=480]/best');
        break;
      case 'fallback':
        baseOptions.push('--extractor-args', 'youtube:player_client=web_creator');
        baseOptions.push('--format', 'worst[ext=mp4]/worst');
        break;
      case 'standard':
      default:
        baseOptions.push('--extractor-args', 'youtube:player_client=web');
        break;
    }

    baseOptions.push(videoUrl);
    
    const commands = ['yt-dlp', 'python3 -m yt_dlp'];
    
    for (const cmd of commands) {
      try {
        return await this.executeDownloadCommand(cmd, baseOptions, processingId, mode);
      } catch (error) {
        console.warn(`Download with ${cmd} (${mode}) failed:`, error.message);
        continue;
      }
    }
    
    throw new Error(`yt-dlp download (${mode}) failed`);
  }

  async executeDownloadCommand(baseCmd, options, processingId, mode) {
    const fullCommand = baseCmd === 'yt-dlp' ? [baseCmd, ...options] : 
                       ['python3', '-m', 'yt_dlp', ...options];

    return new Promise((resolve, reject) => {
      const process = spawn(fullCommand[0], fullCommand.slice(1));
      let stderr = '';
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        const progress = data.toString();
        if (progress.includes('%') && !progress.includes('ERROR')) {
          console.log(`[${processingId}] Download (${mode}): ${progress.trim()}`);
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
            console.log(`[${processingId}] Download completed (${mode}): ${outputFile}`);
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
      }, 900000);
    });
  }

  async downloadWithYoutubeDl(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    
    try {
      await youtubedl(videoUrl, {
        output: outputTemplate,
        format: 'best[height<=720]',
        mergeOutputFormat: 'mp4'
      });
      
      const files = await fs.readdir(this.tempDir);
      const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
      
      if (!outputFile) {
        throw new Error('Downloaded file not found');
      }
      
      return path.join(this.tempDir, outputFile);
    } catch (error) {
      throw new Error(`youtube-dl download failed: ${error.message}`);
    }
  }

  async downloadWithYtdlCore(videoUrl, processingId, mode = 'default') {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    
    return new Promise((resolve, reject) => {
      try {
        const options = {
          quality: mode === 'fallback' ? 'lowest' : 'highest',
          filter: 'audioandvideo',
          requestOptions: {
            headers: {
              'User-Agent': this.getRandomUserAgent(),
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': 'https://www.youtube.com/',
            }
          }
        };

        if (mode === 'fallback') {
          options.quality = 'lowestvideo';
        }

        const stream = ytdl(videoUrl, options);
        const writeStream = fsSync.createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        stream.on('progress', (chunkLength, downloaded, total) => {
          const percent = (downloaded / total * 100).toFixed(1);
          console.log(`[${processingId}] ytdl-core (${mode}) download: ${percent}%`);
        });
        
        stream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve(outputPath));
        
      } catch (error) {
        reject(error);
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

  isBotDetectionError(error) {
    const errorMsg = error.message.toLowerCase();
    return errorMsg.includes('sign in to confirm') || 
           errorMsg.includes('bot') || 
           errorMsg.includes('verify') ||
           errorMsg.includes('captcha') ||
           errorMsg.includes('blocked') ||
           errorMsg.includes('403') ||
           errorMsg.includes('429') ||
           errorMsg.includes('too many requests') ||
           errorMsg.includes('quota exceeded');
  }

  isRateLimitError(error) {
    const errorMsg = error.message.toLowerCase();
    return errorMsg.includes('410') ||
           errorMsg.includes('429') ||
           errorMsg.includes('rate limit') ||
           errorMsg.includes('too many requests') ||
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