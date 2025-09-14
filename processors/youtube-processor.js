// processors/youtube-processor-enhanced-2025.js - With YouTube Data API v3 Integration
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

class YouTubeProcessor {
  constructor() {
    this.tempDir = '/tmp/processing';
    this.outputDir = '/tmp/output';
    this.maxRetries = 1;
    
    // YouTube Data API v3 configuration
    this.youtubeApiKey = process.env.YOUTUBE_API_KEY;
    this.youtubeApiBaseUrl = 'https://www.googleapis.com/youtube/v3';
    
    if (!this.youtubeApiKey) {
      console.warn('YouTube API key not found. Some features may be limited.');
    } else {
      console.log('YouTube Data API v3 initialized successfully');
    }
    
    // Realistic browser profiles for 2025
    this.browserProfiles = [
      {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        acceptLanguage: 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        acceptEncoding: 'gzip, deflate, br',
        dnt: '1',
        upgradeInsecureRequests: '1',
        secFetchSite: 'none',
        secFetchMode: 'navigate',
        secFetchUser: '?1',
        secFetchDest: 'document'
      },
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        acceptLanguage: 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        acceptEncoding: 'gzip, deflate, br',
        dnt: '1',
        upgradeInsecureRequests: '1',
        secFetchSite: 'none',
        secFetchMode: 'navigate',
        secFetchUser: '?1',
        secFetchDest: 'document'
      },
      {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        acceptLanguage: 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        acceptEncoding: 'gzip, deflate, br',
        dnt: '1',
        upgradeInsecureRequests: '1',
        secFetchSite: 'none',
        secFetchMode: 'navigate',
        secFetchUser: '?1',
        secFetchDest: 'document'
      }
    ];
    
    this.currentProfileIndex = 0;
    this.lastRequestTime = 0;
    this.minRequestInterval = parseInt(process.env.YOUTUBE_MIN_DELAY) || 60000;
    this.consecutiveFailures = 0;
    this.sessionId = crypto.randomBytes(16).toString('hex');
    
    this.initializeTools();
  }

  async initializeTools() {
    this.availableTools = {
      ytDlp: await this.checkYtDlpAdvanced(),
      ytdlCore: true,
      youtubeApi: !!this.youtubeApiKey
    };
    
    console.log('Available YouTube tools:', this.availableTools);
    
    if (this.availableTools.ytDlp) {
      console.log('Using yt-dlp command:', this.ytDlpCommand);
    } else {
      console.warn('yt-dlp not available - using ytdl-core only');
    }
  }

  async checkYtDlpAdvanced() {
    const commands = [
      '/opt/render/project/bin/yt-dlp',
      'yt-dlp',
      'python3 -m yt_dlp',
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp'
    ];
    
    for (const cmd of commands) {
      try {
        const result = await new Promise((resolve) => {
          exec(`${cmd} --version`, { timeout: 15000 }, (error, stdout, stderr) => {
            if (!error && stdout) {
              resolve({ success: true, command: cmd, version: stdout.trim() });
            } else {
              resolve({ success: false, error: error?.message || stderr });
            }
          });
        });
        
        if (result.success) {
          console.log(`yt-dlp found: ${result.command}, version: ${result.version}`);
          this.ytDlpCommand = result.command;
          return true;
        } else {
          console.log(`Command ${cmd} failed: ${result.error}`);
        }
      } catch (error) {
        console.log(`Command ${cmd} exception: ${error.message}`);
        continue;
      }
    }
    
    console.warn('yt-dlp not found in any location');
    return false;
  }

  getCurrentProfile() {
    const profile = this.browserProfiles[this.currentProfileIndex];
    this.currentProfileIndex = (this.currentProfileIndex + 1) % this.browserProfiles.length;
    return profile;
  }

  async enforceAdvancedRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    // Enhanced rate limiting for 2025
    const baseInterval = this.minRequestInterval;
    const backoffMultiplier = Math.min(Math.pow(3, this.consecutiveFailures), 16);
    const jitter = Math.random() * 30000; // 0-30 seconds random jitter
    const totalDelay = baseInterval * backoffMultiplier + jitter;
    
    if (timeSinceLastRequest < totalDelay) {
      const sleepTime = totalDelay - timeSinceLastRequest;
      console.log(`Rate limit: waiting ${Math.round(sleepTime/1000)}s (backoff: ${backoffMultiplier.toFixed(1)}x)`);
      await this.sleep(sleepTime);
    }
    
    this.lastRequestTime = Date.now();
  }

  // NEW: YouTube Data API v3 Integration
  async getVideoInfoFromYouTubeAPI(videoUrl, processingId) {
    if (!this.youtubeApiKey) {
      throw new Error('YouTube API key not configured');
    }

    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID from URL');
    }

    console.log(`[${processingId}] Fetching video info via YouTube Data API v3`);

    try {
      const response = await axios.get(`${this.youtubeApiBaseUrl}/videos`, {
        params: {
          part: 'snippet,contentDetails,statistics,status',
          id: videoId,
          key: this.youtubeApiKey
        },
        timeout: 30000,
        headers: {
          'User-Agent': this.getCurrentProfile().userAgent,
          'Accept': 'application/json'
        }
      });

      if (!response.data.items || response.data.items.length === 0) {
        throw new Error('Video not found or is private/deleted');
      }

      const video = response.data.items[0];
      const snippet = video.snippet;
      const contentDetails = video.contentDetails;
      const statistics = video.statistics;
      const status = video.status;

      // Check if video is available
      if (status.privacyStatus === 'private') {
        throw new Error('Video is private');
      }
      
      if (status.uploadStatus !== 'processed') {
        throw new Error('Video is still processing on YouTube');
      }

      // Parse duration from ISO 8601 format (PT15M33S)
      const duration = this.parseISO8601Duration(contentDetails.duration);
      
      // Check for content restrictions
      const restrictions = [];
      if (contentDetails.contentRating?.ytRating === 'ytAgeRestricted') {
        restrictions.push('age_restricted');
      }
      if (contentDetails.regionRestriction?.blocked?.length > 0) {
        restrictions.push('region_blocked');
      }
      if (snippet.liveBroadcastContent !== 'none') {
        restrictions.push('live_content');
      }

      const videoInfo = {
        video_id: videoId,
        title: snippet.title || 'Unknown Title',
        description: (snippet.description || '').substring(0, 1000),
        author: snippet.channelTitle || 'Unknown Channel',
        channel_id: snippet.channelId,
        duration: duration,
        view_count: parseInt(statistics.viewCount) || 0,
        like_count: parseInt(statistics.likeCount) || 0,
        comment_count: parseInt(statistics.commentCount) || 0,
        upload_date: snippet.publishedAt?.substring(0, 10).replace(/-/g, '') || new Date().toISOString().substring(0, 10).replace(/-/g, ''),
        thumbnail: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
        category_id: snippet.categoryId,
        is_live: snippet.liveBroadcastContent !== 'none',
        privacy_status: status.privacyStatus,
        embeddable: status.embeddable,
        public_stats_viewable: status.publicStatsViewable,
        restrictions: restrictions,
        tags: snippet.tags || [],
        default_language: snippet.defaultLanguage,
        api_source: 'youtube_data_api_v3'
      };

      // Additional validation based on API data
      if (restrictions.includes('age_restricted')) {
        throw new Error('Video is age-restricted and cannot be processed');
      }

      if (restrictions.includes('live_content')) {
        throw new Error('Live streams are not supported');
      }

      if (!status.embeddable) {
        console.warn(`[${processingId}] Video is not embeddable, may have download restrictions`);
      }

      console.log(`[${processingId}] YouTube API info retrieved: ${videoInfo.title} (${duration}s)`);
      return videoInfo;

    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error?.message || error.message;
        
        if (status === 403) {
          throw new Error(`YouTube API quota exceeded or access forbidden: ${message}`);
        } else if (status === 404) {
          throw new Error('Video not found or is private/deleted');
        } else if (status === 400) {
          throw new Error(`Invalid request to YouTube API: ${message}`);
        } else {
          throw new Error(`YouTube API error (${status}): ${message}`);
        }
      } else {
        throw new Error(`YouTube API request failed: ${error.message}`);
      }
    }
  }

  // NEW: Parse ISO 8601 duration format
  parseISO8601Duration(duration) {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    
    const hours = parseInt(match[1]) || 0;
    const minutes = parseInt(match[2]) || 0;
    const seconds = parseInt(match[3]) || 0;
    
    return hours * 3600 + minutes * 60 + seconds;
  }

  // NEW: Get channel information
  async getChannelInfo(channelId, processingId) {
    if (!this.youtubeApiKey || !channelId) {
      return null;
    }

    try {
      const response = await axios.get(`${this.youtubeApiBaseUrl}/channels`, {
        params: {
          part: 'snippet,statistics,brandingSettings',
          id: channelId,
          key: this.youtubeApiKey
        },
        timeout: 20000
      });

      if (!response.data.items || response.data.items.length === 0) {
        return null;
      }

      const channel = response.data.items[0];
      return {
        channel_id: channelId,
        channel_title: channel.snippet.title,
        channel_description: (channel.snippet.description || '').substring(0, 500),
        subscriber_count: parseInt(channel.statistics.subscriberCount) || 0,
        video_count: parseInt(channel.statistics.videoCount) || 0,
        view_count: parseInt(channel.statistics.viewCount) || 0,
        country: channel.snippet.country,
        custom_url: channel.snippet.customUrl,
        thumbnail: channel.snippet.thumbnails?.high?.url
      };
    } catch (error) {
      console.warn(`[${processingId}] Failed to get channel info:`, error.message);
      return null;
    }
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
    
    console.log(`[${processing_id}] Starting enhanced YouTube processing with API integration (2025)`);
    
    if (!supabase_config?.url || !supabase_config?.service_key) {
      throw new Error('Missing Supabase configuration');
    }
    
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    const startTime = Date.now();
    
    try {
      await this.ensureDirectories();
      
      const videoId = this.extractVideoId(video_url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL format');
      }
      
      console.log(`[${processing_id}] Getting video information with API integration`);
      const videoDetails = await this.getVideoInfoSafeWithAPI(video_url, processing_id);
      
      // Get additional channel info if available
      let channelInfo = null;
      if (videoDetails.channel_id && this.youtubeApiKey) {
        channelInfo = await this.getChannelInfo(videoDetails.channel_id, processing_id);
      }
      
      console.log(`[${processing_id}] Downloading video`);
      originalVideoPath = await this.downloadVideoSafe(video_url, processing_id);
      
      await this.validateDownloadedFile(originalVideoPath, processing_id);
      
      const metadata = await this.getVideoMetadata(originalVideoPath);
      console.log(`[${processing_id}] Video: ${metadata.duration}s, ${metadata.size_mb}MB`);
      
      this.validateVideoForProcessing(metadata, subscription_type);
      
      console.log(`[${processing_id}] Creating shorts`);
      const shorts = await this.createShorts(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        video_info: { ...video_info, ...videoDetails }
      });
      
      console.log(`[${processing_id}] Generating thumbnails`);
      const shortsWithThumbnails = await this.generateThumbnails(shorts, processing_id);
      
      console.log(`[${processing_id}] Uploading to storage`);
      const uploadedShorts = await this.uploadToStorage(shortsWithThumbnails, supabase, processing_id);
      
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: { ...video_info, ...videoDetails },
        channel_info: channelInfo,
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      await this.cleanup(processing_id);
      this.consecutiveFailures = 0;
      
      const processingTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${processing_id}] Completed in ${processingTime}s`);
      
      return {
        processing_id,
        shorts_results: uploadedShorts,
        total_shorts: uploadedShorts.length,
        video_info: { 
          ...video_info, 
          ...videoDetails,
          channel_info: channelInfo
        },
        platform: 'YouTube',
        subscription_type,
        processing_completed_at: new Date().toISOString(),
        usage_stats: {
          original_duration: metadata.duration,
          original_size_mb: metadata.size_mb,
          processing_time_seconds: processingTime,
          shorts_total_duration: uploadedShorts.reduce((sum, short) => sum + (short.duration || 60), 0),
          api_source: videoDetails.api_source || 'fallback'
        }
      };
      
    } catch (error) {
      console.error(`[${processing_id}] Processing failed:`, error);
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

  // ENHANCED: Video info with API integration
  async getVideoInfoSafeWithAPI(videoUrl, processingId) {
    const methods = [
      () => this.getVideoInfoFromYouTubeAPI(videoUrl, processingId),
      () => this.getVideoInfoViaOEmbed(videoUrl, processingId),
      () => this.getVideoInfoWithYtdlCore(videoUrl, processingId),
      () => this.getVideoInfoFallback(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      try {
        console.log(`[${processingId}] Info method ${index + 1}/${methods.length} ${index === 0 ? '(YouTube API)' : ''}`);
        
        if (index > 0) {
          await this.sleep(5000); // 5 second delay between methods
        }
        
        const result = await method();
        console.log(`[${processingId}] Info method ${index + 1} succeeded`);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Info method ${index + 1} failed: ${error.message}`);
        
        // If YouTube API fails with quota/auth issues, skip to next method immediately
        if (index === 0 && error.message.includes('quota')) {
          console.log(`[${processingId}] YouTube API quota exceeded, falling back to other methods`);
        }
      }
    }
    
    // If all methods fail, return fallback info
    console.warn(`[${processingId}] All info methods failed, using fallback`);
    return this.getVideoInfoFallback(videoUrl, processingId);
  }

  async getVideoInfoViaOEmbed(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID');
    }

    const profile = this.getCurrentProfile();
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    
    const response = await axios.get(oembedUrl, {
      timeout: 20000,
      headers: {
        'User-Agent': profile.userAgent,
        'Accept': 'application/json',
        'Accept-Language': profile.acceptLanguage,
        'Accept-Encoding': profile.acceptEncoding,
        'DNT': profile.dnt,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Cache-Control': 'no-cache'
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
      category: 'Unknown',
      api_source: 'oembed'
    };
  }

  async getVideoInfoWithYtdlCore(videoUrl, processingId) {
    const profile = this.getCurrentProfile();
    
    try {
      const options = {
        requestOptions: {
          timeout: 45000,
          headers: {
            'User-Agent': profile.userAgent,
            'Accept-Language': profile.acceptLanguage,
            'Accept': profile.accept,
            'Accept-Encoding': profile.acceptEncoding,
            'DNT': profile.dnt,
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
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
        category: details.category || 'Unknown',
        api_source: 'ytdl_core'
      };
    } catch (error) {
      throw new Error(`ytdl-core failed: ${error.message}`);
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
      category: 'Unknown',
      api_source: 'fallback'
    };
  }

  async downloadVideoSafe(videoUrl, processingId) {
    await this.enforceAdvancedRateLimit();
    
    const methods = [
      () => this.downloadWithYtDlp(videoUrl, processingId),
      () => this.downloadWithYtdlCore(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      // Skip yt-dlp if not available
      if (index === 0 && !this.availableTools.ytDlp) {
        console.log(`[${processingId}] Skipping yt-dlp (not available)`);
        continue;
      }
      
      try {
        console.log(`[${processingId}] Download method ${index + 1}/${methods.length}`);
        
        if (index > 0) {
          await this.enforceAdvancedRateLimit();
        }
        
        const result = await method();
        console.log(`[${processingId}] Download method ${index + 1} succeeded`);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Download method ${index + 1} failed: ${error.message}`);
        
        await this.cleanupFailedDownload(processingId);
        
        if (index < methods.length - 1) {
          await this.sleep(30000); // 30 second delay between methods
        }
      }
    }
    
    throw new Error(`All download methods failed: ${lastError?.message || 'Unknown error'}`);
  }

  async downloadWithYtDlp(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    const profile = this.getCurrentProfile();
    
    const options = [
      '--output', outputTemplate,
      '--format', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--socket-timeout', '120',
      '--retries', '0',
      '--user-agent', profile.userAgent,
      '--add-header', `Accept-Language:${profile.acceptLanguage}`,
      '--add-header', `Accept:${profile.accept}`,
      '--extractor-args', 'youtube:player_client=android',
      '--throttled-rate', '1M',
      videoUrl
    ];
    
    return new Promise((resolve, reject) => {
      const cmdParts = this.ytDlpCommand.split(' ');
      const process = spawn(cmdParts[0], cmdParts.slice(1).concat(options));
      
      let stderr = '';
      let hasOutput = false;
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        if (data.toString().includes('%')) {
          hasOutput = true;
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
            console.log(`[${processingId}] yt-dlp completed: ${outputFile}`);
            resolve(filePath);
          } catch (error) {
            reject(new Error(`File location failed: ${error.message}`));
          }
        } else {
          const errorMsg = stderr || 'yt-dlp process failed';
          reject(new Error(`yt-dlp failed (code ${code}): ${errorMsg}`));
        }
      });

      process.on('error', (error) => {
        reject(new Error(`yt-dlp spawn error: ${error.message}`));
      });

      setTimeout(() => {
        if (!hasOutput) {
          process.kill('SIGKILL');
          reject(new Error('yt-dlp timeout - no progress detected'));
        }
      }, 600000); // 10 minutes
    });
  }

  async downloadWithYtdlCore(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    const profile = this.getCurrentProfile();
    
    return new Promise((resolve, reject) => {
      try {
        const options = {
          quality: 'highestvideo[height<=720]+bestaudio/best[height<=720]/best',
          requestOptions: {
            timeout: 300000, // 5 minutes
            headers: {
              'User-Agent': profile.userAgent,
              'Accept-Language': profile.acceptLanguage,
              'Accept': profile.accept,
              'Accept-Encoding': profile.acceptEncoding,
              'DNT': profile.dnt,
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache'
            }
          },
          highWaterMark: 1024 * 1024 * 16 // 16MB buffer
        };

        const stream = ytdl(videoUrl, options);
        const writeStream = fsSync.createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        let totalDownloaded = 0;
        let lastProgress = 0;
        
        stream.on('progress', (chunkLength, downloaded, total) => {
          totalDownloaded = downloaded;
          if (total > 0) {
            const percent = Math.round(downloaded / total * 100);
            if (percent - lastProgress >= 20) {
              console.log(`[${processingId}] ytdl-core progress: ${percent}%`);
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
          console.log(`[${processingId}] ytdl-core completed: ${Math.round(totalDownloaded / 1024 / 1024)}MB`);
          resolve(outputPath);
        });
        
        setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('ytdl-core timeout'));
        }, 600000); // 10 minutes
        
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

  async validateDownloadedFile(filePath, processingId) {
    try {
      const stats = await fs.stat(filePath);
      
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }
      
      if (stats.size < 10240) {
        const content = await fs.readFile(filePath, 'utf8');
        if (content.includes('<!DOCTYPE html>')) {
          throw new Error('Downloaded file is HTML (bot detection page)');
        }
      }

      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            reject(new Error(`Invalid video file: ${err.message}`));
            return;
          }
          
          const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
          if (!videoStream) {
            reject(new Error('No video stream found'));
            return;
          }
          
          console.log(`[${processingId}] File validated: ${Math.round(stats.size / 1024 / 1024)}MB`);
          resolve();
        });
      });
      
    } catch (error) {
      throw new Error(`File validation failed: ${error.message}`);
    }
  }

  async getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Metadata read failed: ${err.message}`));
          return;
        }
        
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const format = metadata.format;
        
        if (!videoStream) {
          reject(new Error('No video stream found'));
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
      throw new Error(`Video too long. Max: ${maxDuration / 60} minutes for ${subscriptionType}`);
    }
    
    const maxSizeMB = subscriptionType === 'free' ? 100 : 500;
    if (metadata.size_mb > maxSizeMB) {
      throw new Error(`Video too large. Max: ${maxSizeMB}MB for ${subscriptionType}`);
    }
    
    if (metadata.width < 480 || metadata.height < 360) {
      throw new Error('Resolution too low. Minimum: 480x360');
    }
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
      throw new Error('Video too short (minimum 60 seconds required)');
    }
    
    console.log(`[${processing_id}] Creating ${numShorts} shorts`);
    
    const shorts = [];
    const interval = Math.max(segmentDuration, (video_duration - segmentDuration) / numShorts);
    
    for (let i = 0; i < numShorts; i++) {
      const startTime = Math.floor(i * interval);
      const actualDuration = Math.min(segmentDuration, video_duration - startTime);
      
      if (actualDuration < 30) continue;
      
      const shortId = `short_${processing_id}_${i + 1}`;
      const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
      
      console.log(`[${processing_id}] Creating short ${i + 1}/${numShorts}`);
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
          // Reduced logging
          if (progress.percent && Math.round(progress.percent) % 50 === 0) {
            console.log(`Processing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => resolve())
        .on('error', (error) => reject(new Error(`Processing failed: ${error.message}`)))
        .save(outputPath);
    });
  }

  async generateThumbnails(shorts, processingId) {
    console.log(`[${processingId}] Generating ${shorts.length} thumbnails`);
    
    for (const [index, short] of shorts.entries()) {
      const thumbnailPath = path.join(this.outputDir, `${short.short_id}_thumbnail.jpg`);
      
      try {
        await this.extractThumbnail(short.local_path, thumbnailPath);
        short.thumbnail_path = thumbnailPath;
        const stats = await fs.stat(thumbnailPath);
        short.thumbnail_size = stats.size;
        
        console.log(`[${processingId}] Thumbnail ${index + 1}/${shorts.length} created`);
      } catch (error) {
        console.error(`[${processingId}] Thumbnail failed for ${short.short_id}:`, error);
        short.thumbnail_path = null;
      }
    }
    
    return shorts;
  }

  async extractThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(5) // 5 seconds into the video
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
    console.log(`[${processingId}] Uploading ${shorts.length} shorts to storage`);
    const uploadedShorts = [];
    
    for (const [index, short] of shorts.entries()) {
      try {
        console.log(`[${processingId}] Uploading ${index + 1}/${shorts.length}: ${short.short_id}`);
        
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
        
        if (videoError) {
          console.error(`Video upload error for ${short.short_id}:`, videoError);
          throw videoError;
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
                upsert: false
              });
            
            if (!thumbnailError) {
              const { data: { publicUrl } } = supabase.storage
                .from('thumbnails')
                .getPublicUrl(thumbnailKey);
              
              thumbnailUrl = publicUrl;
              thumbnailStoragePath = thumbnailKey;
            } else {
              console.warn(`Thumbnail upload failed for ${short.short_id}:`, thumbnailError);
            }
          } catch (thumbError) {
            console.error(`Thumbnail processing error for ${short.short_id}:`, thumbError);
          }
        }
        
        // Get public URL for video
        const { data: { publicUrl: videoUrl } } = supabase.storage
          .from('processed-shorts')
          .getPublicUrl(videoKey);
        
        const uploadedShort = {
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
        };
        
        uploadedShorts.push(uploadedShort);
        console.log(`[${processingId}] Successfully uploaded ${short.short_id}`);
        
      } catch (error) {
        console.error(`[${processingId}] Upload failed for ${short.short_id}:`, error);
        // Continue with other shorts even if one fails
      }
    }
    
    if (uploadedShorts.length === 0) {
      throw new Error('Failed to upload any shorts to storage');
    }
    
    console.log(`[${processingId}] Successfully uploaded ${uploadedShorts.length}/${shorts.length} shorts`);
    return uploadedShorts;
  }

  // ENHANCED: Database save with API data
  async saveToDatabase(supabase, data) {
    try {
      console.log(`[${data.processing_id}] Saving to database with API data`);
      
      // Save processing record with enhanced data
      const { error: processError } = await supabase
        .from('video_processing')
        .upsert({
          processing_id: data.processing_id,
          original_url: data.video_info.url || 'Unknown',
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
          // Enhanced with API data
          youtube_data: {
            video_id: data.video_info.video_id,
            view_count: data.video_info.view_count,
            like_count: data.video_info.like_count,
            comment_count: data.video_info.comment_count,
            category_id: data.video_info.category_id,
            is_live: data.video_info.is_live,
            privacy_status: data.video_info.privacy_status,
            embeddable: data.video_info.embeddable,
            restrictions: data.video_info.restrictions,
            tags: data.video_info.tags,
            api_source: data.video_info.api_source
          },
          channel_data: data.channel_info,
          shorts_count: data.shorts.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (processError) {
        console.error('Failed to save processing record:', processError);
      } else {
        console.log(`[${data.processing_id}] Processing record saved with API data`);
      }

      // Save individual shorts
      let savedCount = 0;
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
        } else {
          savedCount++;
        }
      }

      console.log(`[${data.processing_id}] Saved ${savedCount}/${data.shorts.length} shorts to database`);

    } catch (error) {
      console.error(`[${data.processing_id}] Database save error:`, error);
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
          // Directory might not exist, ignore
        }
      }

      console.log(`[${processingId}] Cleaned up ${cleanedFiles} files`);
    } catch (error) {
      console.error(`[${processingId}] Cleanup error:`, error);
    }
  }

  enhanceError(error, processingId, videoUrl) {
    const message = error.message.toLowerCase();
    
    if (message.includes('youtube api')) {
      return new Error(`YouTube API error: ${error.message}. Please check your API key and quota limits.`);
    } else if (message.includes('quota exceeded')) {
      return new Error('YouTube API quota exceeded. Please wait for quota reset or upgrade your quota limits.');
    } else if (message.includes('410')) {
      return new Error('YouTube detected automated access. This video may be restricted or age-gated. Try a different video or wait 10+ minutes before retrying.');
    } else if (message.includes('429')) {
      return new Error('Rate limited by YouTube. Please wait 10-15 minutes before trying again.');
    } else if (message.includes('403') || message.includes('forbidden')) {
      return new Error('Access forbidden. This video may be geo-blocked, private, or require authentication.');
    } else if (message.includes('404') || message.includes('not found')) {
      return new Error('Video not found. Please check the URL and ensure the video exists.');
    } else if (message.includes('unavailable') || message.includes('private')) {
      return new Error('Video is private, unavailable, or deleted. Please verify the URL and try a different video.');
    } else if (message.includes('age-restricted') || message.includes('sign in')) {
      return new Error('Video is age-restricted and cannot be processed. Please try a different video.');
    } else if (message.includes('region') || message.includes('blocked')) {
      return new Error('Video is not available in your region. Please try a different video.');
    } else if (message.includes('timeout')) {
      return new Error('Network timeout occurred. Please try again in a few minutes.');
    } else if (message.includes('too large')) {
      return new Error('Video file is too large for processing. Please try a shorter video.');
    } else if (message.includes('too long')) {
      return new Error('Video is too long for processing. Please try a shorter video.');
    } else if (message.includes('too short')) {
      return new Error('Video is too short to create shorts (minimum 60 seconds required).');
    } else if (message.includes('ffmpeg') || message.includes('encoding')) {
      return new Error('Video encoding failed. The video format may not be supported.');
    } else if (message.includes('download')) {
      return new Error('Failed to download the video. Please check the URL and try again.');
    } else if (message.includes('storage') || message.includes('upload')) {
      return new Error('Failed to save processed videos. Please try again.');
    } else if (message.includes('invalid') && message.includes('url')) {
      return new Error('Invalid YouTube URL format. Please provide a valid YouTube video URL.');
    } else {
      return new Error(`Video processing failed: ${error.message}. Please try a different video or contact support if the issue persists.`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = YouTubeProcessor;