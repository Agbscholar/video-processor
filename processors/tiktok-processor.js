const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs').promises;
const BaseProcessor = require('./base-processor');

/**
 * TikTok processor class for handling TikTok video processing
 * Extends BaseProcessor to inherit common functionality
 */
class TikTokProcessor extends BaseProcessor {
  constructor() {
    super();
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Android 11; Mobile; rv:68.0) Gecko/68.0 Firefox/88.0'
    ];
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
    
    console.log(`[${processing_id}] Starting TikTok video processing`);
    
    // Initialize Supabase client
    const supabase = createClient(supabase_config.url, supabase_config.service_key);
    
    let originalVideoPath = null;
    
    try {
      // 1. Extract TikTok video info and download URL
      console.log(`[${processing_id}] Extracting TikTok video information`);
      const tikTokInfo = await this.getTikTokInfo(video_url, processing_id);
      
      // 2. Download the video
      console.log(`[${processing_id}] Downloading TikTok video`);
      originalVideoPath = await this.downloadTikTokVideo(tikTokInfo.download_url, processing_id);
      
      // 3. Get video metadata
      const metadata = await this.getVideoMetadata(originalVideoPath);
      console.log(`[${processing_id}] TikTok video: ${metadata.duration}s, ${metadata.width}x${metadata.height}`);
      
      // 4. Validate for processing
      this.validateTikTokVideo(metadata, tikTokInfo, subscription_type);
      
      // 5. Create shorts (TikTok videos are usually already short, so handle differently)
      console.log(`[${processing_id}] Processing TikTok video for shorts`);
      const shorts = await this.createTikTokShorts(originalVideoPath, {
        processing_id,
        subscription_type,
        user_limits,
        video_duration: metadata.duration,
        tiktok_info: tikTokInfo,
        metadata
      });
      
      // 6. Generate thumbnails
      console.log(`[${processing_id}] Generating thumbnails`);
      const shortsWithThumbnails = await this.generateThumbnails(shorts, processing_id);
      
      // 7. Upload to storage
      console.log(`[${processing_id}] Uploading to cloud storage`);
      const uploadedShorts = await this.uploadToStorage(shortsWithThumbnails, supabase, processing_id);
      
      // 8. Save to database
      await this.saveToDatabase(supabase, {
        processing_id,
        video_info: { ...video_info, ...tikTokInfo },
        shorts: uploadedShorts,
        subscription_type,
        metadata
      });
      
      // 9. Cleanup
      await this.cleanup(processing_id);
      
      console.log(`[${processing_id}] TikTok processing completed successfully`);
      
      return {
        processing_id,
        shorts_results: uploadedShorts,
        total_shorts: uploadedShorts.length,
        video_info: { ...video_info, ...tikTokInfo },
        platform: 'TikTok',
        subscription_type,
        processing_completed_at: new Date().toISOString(),
        usage_stats: {
          original_duration: metadata.duration,
          original_size_mb: metadata.size_mb,
          processing_time: `${Math.round(metadata.processing_time / 1000)} seconds`,
          is_original_short: metadata.duration <= 180 // TikTok videos are typically short
        }
      };
      
    } catch (error) {
      console.error(`[${processing_id}] TikTok processing failed:`, error);
      
      if (originalVideoPath) {
        await this.cleanup(processing_id);
      }
      
      throw this.enhanceTikTokError(error, processing_id, video_url);
    }
  }

  async getTikTokInfo(videoUrl, processingId) {
    try {
      // Clean and validate TikTok URL
      const cleanUrl = this.cleanTikTokUrl(videoUrl);
      if (!cleanUrl) {
        throw new Error('Invalid TikTok URL format');
      }
      
      console.log(`[${processingId}] Fetching TikTok metadata from: ${cleanUrl}`);
      
      // Try multiple extraction methods
      let tikTokData = null;
      
      // Method 1: Try direct video page scraping
      try {
        tikTokData = await this.scrapeTikTokPage(cleanUrl, processingId);
      } catch (error) {
        console.warn(`[${processingId}] Direct scraping failed:`, error.message);
      }
      
      // Method 2: Try alternative extraction (if Method 1 fails)
      if (!tikTokData || !tikTokData.download_url) {
        try {
          tikTokData = await this.extractTikTokAlternative(cleanUrl, processingId);
        } catch (error) {
          console.warn(`[${processingId}] Alternative extraction failed:`, error.message);
        }
      }
      
      if (!tikTokData || !tikTokData.download_url) {
        throw new Error('Unable to extract TikTok video download URL. The video may be private or region-locked.');
      }
      
      return {
        title: tikTokData.title || 'TikTok Video',
        description: tikTokData.description || '',
        author: tikTokData.author || 'TikTok User',
        duration: tikTokData.duration || 0,
        view_count: tikTokData.view_count || 0,
        like_count: tikTokData.like_count || 0,
        comment_count: tikTokData.comment_count || 0,
        share_count: tikTokData.share_count || 0,
        video_id: tikTokData.video_id || this.extractVideoId(cleanUrl),
        thumbnail: tikTokData.thumbnail,
        download_url: tikTokData.download_url,
        original_url: cleanUrl,
        music: tikTokData.music || null,
        hashtags: tikTokData.hashtags || [],
        is_private: tikTokData.is_private || false
      };
      
    } catch (error) {
      console.error(`[${processingId}] TikTok info extraction failed:`, error);
      
      if (error.message.includes('private') || error.message.includes('not found')) {
        throw new Error('TikTok video is private, deleted, or not accessible');
      } else if (error.message.includes('region')) {
        throw new Error('TikTok video is not available in this region');
      } else {
        throw new Error(`Failed to extract TikTok video information: ${error.message}`);
      }
    }
  }

  cleanTikTokUrl(url) {
    // Handle various TikTok URL formats
    const patterns = [
      /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/,
      /(?:https?:\/\/)?vm\.tiktok\.com\/(\w+)/,
      /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/t\/(\w+)/,
      /(?:https?:\/\/)?m\.tiktok\.com\/v\/(\d+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        // Convert short URLs to full URLs when possible
        if (url.includes('vm.tiktok.com') || url.includes('/t/')) {
          return url; // Keep short URLs as-is for now
        } else {
          return `https://www.tiktok.com/@${match[1] ? 'user' : 'unknown'}/video/${match[1]}`;
        }
      }
    }
    
    // If no pattern matches, try to extract just the video ID
    const videoIdMatch = url.match(/(\d{19})/); // TikTok video IDs are typically 19 digits
    if (videoIdMatch) {
      return `https://www.tiktok.com/@unknown/video/${videoIdMatch[1]}`;
    }
    
    return null;
  }

  extractVideoId(url) {
    const match = url.match(/\/video\/(\d+)/);
    return match ? match[1] : Date.now().toString();
  }

  async scrapeTikTokPage(url, processingId) {
    try {
      const userAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 30000,
        maxRedirects: 5
      });
      
      const html = response.data;
      
      // Extract data from various sources in the HTML
      let videoData = {};
      
      // Try to extract from __UNIVERSAL_DATA_FOR_REHYDRATION__
      const universalDataMatch = html.match(/<script[^>]*>window\.__UNIVERSAL_DATA_FOR_REHYDRATION__\s*=\s*({.+?})<\/script>/);
      if (universalDataMatch) {
        try {
          const data = JSON.parse(universalDataMatch[1]);
          const videoDetails = this.extractFromUniversalData(data);
          if (videoDetails) videoData = { ...videoData, ...videoDetails };
        } catch (e) {
          console.warn(`[${processingId}] Failed to parse universal data:`, e.message);
        }
      }
      
      // Try to extract from __NEXT_DATA__
      const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>({.+?})<\/script>/);
      if (nextDataMatch) {
        try {
          const data = JSON.parse(nextDataMatch[1]);
          const videoDetails = this.extractFromNextData(data);
          if (videoDetails) videoData = { ...videoData, ...videoDetails };
        } catch (e) {
          console.warn(`[${processingId}] Failed to parse next data:`, e.message);
        }
      }
      
      // Extract basic info from meta tags as fallback
      if (!videoData.download_url) {
        videoData = { ...videoData, ...this.extractFromMetaTags(html) };
      }
      
      // Try to find video download URL in various formats
      if (!videoData.download_url) {
        const videoUrlPatterns = [
          /https:\/\/[^"]+\.mp4[^"]*(?=")/g,
          /"playUrl":"([^"]+)"/g,
          /"downloadUrl":"([^"]+)"/g,
          /"playAddr":"([^"]+)"/g
        ];
        
        for (const pattern of videoUrlPatterns) {
          const matches = html.match(pattern);
          if (matches && matches.length > 0) {
            // Clean up the URL (remove escape characters)
            const cleanUrl = matches[0].replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/"/g, '');
            if (cleanUrl.startsWith('http') && cleanUrl.includes('.mp4')) {
              videoData.download_url = cleanUrl;
              break;
            }
          }
        }
      }
      
      return videoData;
      
    } catch (error) {
      throw new Error(`Failed to scrape TikTok page: ${error.message}`);
    }
  }

  extractFromUniversalData(data) {
    try {
      // Navigate through the complex data structure
      const defaultScope = data['__DEFAULT_SCOPE__'];
      if (!defaultScope) return null;
      
      const webapp = defaultScope['webapp.video-detail'];
      if (!webapp || !webapp.itemInfo || !webapp.itemInfo.itemStruct) return null;
      
      const item = webapp.itemInfo.itemStruct;
      
      return {
        title: item.desc || '',
        description: item.desc || '',
        author: item.author?.nickname || item.author?.uniqueId || 'Unknown',
        duration: item.video?.duration || 0,
        view_count: parseInt(item.stats?.playCount) || 0,
        like_count: parseInt(item.stats?.diggCount) || 0,
        comment_count: parseInt(item.stats?.commentCount) || 0,
        share_count: parseInt(item.stats?.shareCount) || 0,
        video_id: item.id,
        thumbnail: item.video?.cover || item.video?.dynamicCover,
        download_url: item.video?.playAddr || item.video?.downloadAddr,
        music: item.music ? {
          title: item.music.title,
          author: item.music.authorName,
          url: item.music.playUrl
        } : null,
        hashtags: item.textExtra?.filter(tag => tag.hashtagName).map(tag => tag.hashtagName) || []
      };
    } catch (error) {
      console.warn('Failed to extract from universal data:', error);
      return null;
    }
  }

  extractFromNextData(data) {
    try {
      // Navigate through Next.js data structure
      const props = data.props?.pageProps;
      if (!props) return null;
      
      const item = props.itemInfo?.itemStruct || props.videoData?.itemInfos;
      if (!item) return null;
      
      return {
        title: item.desc || '',
        description: item.desc || '',
        author: item.author?.nickname || item.author?.uniqueId || 'Unknown',
        duration: item.video?.duration || 0,
        view_count: parseInt(item.stats?.playCount) || 0,
        like_count: parseInt(item.stats?.diggCount) || 0,
        comment_count: parseInt(item.stats?.commentCount) || 0,
        share_count: parseInt(item.stats?.shareCount) || 0,
        video_id: item.id,
        thumbnail: item.video?.cover || item.video?.dynamicCover,
        download_url: item.video?.playAddr || item.video?.downloadAddr
      };
    } catch (error) {
      console.warn('Failed to extract from next data:', error);
      return null;
    }
  }

  extractFromMetaTags(html) {
    const metaData = {};
    
    // Extract title
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    if (titleMatch) metaData.title = titleMatch[1];
    
    // Extract description
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    if (descMatch) metaData.description = descMatch[1];
    
    // Extract thumbnail
    const thumbMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (thumbMatch) metaData.thumbnail = thumbMatch[1];
    
    // Extract video URL
    const videoMatch = html.match(/<meta property="og:video" content="([^"]+)"/);
    if (videoMatch) metaData.download_url = videoMatch[1];
    
    return metaData;
  }

  async extractTikTokAlternative(url, processingId) {
    // Alternative method: Try to resolve short URLs first
    if (url.includes('vm.tiktok.com') || url.includes('/t/')) {
      try {
        console.log(`[${processingId}] Resolving short URL: ${url}`);
        
        const response = await axios.get(url, {
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 400,
          timeout: 10000
        });
        
        const location = response.headers.location;
        if (location) {
          console.log(`[${processingId}] Short URL resolved to: ${location}`);
          return await this.scrapeTikTokPage(location, processingId);
        }
      } catch (redirectError) {
        console.warn(`[${processingId}] Short URL resolution failed:`, redirectError.message);
      }
    }
    
    // If all methods fail, return minimal data structure
    return {
      title: 'TikTok Video',
      description: 'Unable to extract full metadata',
      author: 'TikTok User',
      video_id: this.extractVideoId(url),
      thumbnail: null,
      download_url: null // Will need to be handled gracefully
    };
  }

  async downloadTikTokVideo(downloadUrl, processingId) {
    if (!downloadUrl) {
      throw new Error('No download URL available for TikTok video');
    }
    
    const outputPath = path.join(this.tempDir, `${processingId}_tiktok_original.mp4`);
    
    try {
      console.log(`[${processingId}] Downloading TikTok video from: ${downloadUrl.substring(0, 50)}...`);
      
      const userAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
      
      const response = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream',
        timeout: 120000, // 2 minutes timeout for TikTok
        maxContentLength: this.maxFileSize,
        headers: {
          'User-Agent': userAgent,
          'Referer': 'https://www.tiktok.com/',
          'Accept': 'video/mp4,video/*,*/*'
        }
      });
      
      const writer = require('fs').createWriteStream(outputPath);
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`[${processingId}] TikTok video download completed`);
          resolve(outputPath);
        });
        
        writer.on('error', reject);
        response.data.on('error', reject);
      });
      
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('TikTok video download timeout - video might be too large');
      } else if (error.response?.status === 403) {
        throw new Error('TikTok video download forbidden - video might be private or restricted');
      } else {
        throw new Error(`TikTok video download failed: ${error.message}`);
      }
    }
  }

  validateTikTokVideo(metadata, tikTokInfo, subscriptionType) {
    // TikTok videos are typically short, so adjust validation
    if (metadata.duration < 3) {
      throw new Error('TikTok video is too short (less than 3 seconds)');
    }
    
    // More lenient duration limits for TikTok
    const maxDuration = subscriptionType === 'free' ? 180 : 600; // 3 min free, 10 min premium
    if (metadata.duration > maxDuration) {
      throw new Error(`TikTok video too long: ${Math.round(metadata.duration)}s. Max: ${maxDuration}s for ${subscriptionType} users`);
    }
    
    // Size check (TikTok videos are usually smaller)
    const maxSizeMB = subscriptionType === 'free' ? 50 : 200;
    if (metadata.size_mb > maxSizeMB) {
      throw new Error(`TikTok video too large: ${metadata.size_mb}MB. Max: ${maxSizeMB}MB for ${subscriptionType} users`);
    }
    
    // Resolution check
    if (metadata.width < 360 || metadata.height < 640) {
      console.warn(`TikTok video has low resolution: ${metadata.width}x${metadata.height}`);
    }
    
    console.log(`TikTok video validation passed - ${metadata.duration}s, ${metadata.size_mb}MB, ${metadata.width}x${metadata.height}`);
  }

  async createTikTokShorts(originalVideoPath, options) {
    const { 
      processing_id, 
      subscription_type, 
      user_limits, 
      video_duration, 
      tiktok_info,
      metadata
    } = options;
    
    console.log(`[${processing_id}] Creating shorts from TikTok video (${video_duration}s)`);
    
    const shorts = [];
    
    // TikTok videos are already short-form, so strategy depends on length
    if (video_duration <= 60) {
      // Video is already short enough - just optimize it
      console.log(`[${processing_id}] TikTok video is already short, optimizing quality`);
      
      const shortId = `short_${processing_id}_1`;
      const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
      
      await this.optimizeTikTokVideo(originalVideoPath, shortPath, subscription_type);
      
      const stats = await fs.stat(shortPath);
      
      shorts.push({
        short_id: shortId,
        title: tiktok_info.title || 'TikTok Short',
        local_path: shortPath,
        duration: Math.round(video_duration),
        start_time: 0,
        file_size: stats.size,
        file_size_mb: Math.round(stats.size / 1024 / 1024 * 100) / 100,
        quality: subscription_type === 'free' ? '720p' : '1080p',
        segment_index: 1,
        is_full_video: true,
        watermark: subscription_type === 'free' ? '@VideoShortsBot' : null
      });
      
    } else if (video_duration <= 180) {
      // Video is 1-3 minutes - create 2-3 segments
      const numShorts = Math.min(
        subscription_type === 'free' ? 2 : 3,
        Math.floor(video_duration / 45) // At least 45s per segment
      );
      
      const segmentDuration = Math.floor(video_duration / numShorts);
      
      for (let i = 0; i < numShorts; i++) {
        const startTime = i * segmentDuration;
        const actualDuration = Math.min(60, video_duration - startTime); // Max 60s per short
        
        if (actualDuration >= 30) {
          const shortId = `short_${processing_id}_${i + 1}`;
          const shortPath = path.join(this.outputDir, `${shortId}.mp4`);
          
          await this.extractTikTokSegment(
            originalVideoPath, 
            shortPath, 
            startTime, 
            actualDuration, 
            subscription_type
          );
          
          const stats = await fs.stat(shortPath);
          
          shorts.push({
            short_id: shortId,
            title: `${tiktok_info.title || 'TikTok Short'} - Part ${i + 1}`,
            local_path: shortPath,
            duration: Math.round(actualDuration),
            start_time: startTime,
            file_size: stats.size,
            file_size_mb: Math.round(stats.size / 1024 / 1024 * 100) / 100,
            quality: subscription_type === 'free' ? '720p' : '1080p',
            segment_index: i + 1,
            watermark: subscription_type === 'free' ? '@VideoShortsBot' : null
          });
        }
      }
    } else {
      // Longer TikTok video (rare) - use standard segmentation
      return await super.createShorts(originalVideoPath, options);
    }
    
    if (shorts.length === 0) {
      throw new Error('Failed to create any shorts from TikTok video');
    }
    
    console.log(`[${processing_id}] Created ${shorts.length} shorts from TikTok video`);
    return shorts;
  }

  async optimizeTikTokVideo(inputPath, outputPath, subscriptionType) {
    return new Promise((resolve, reject) => {
      const quality = subscriptionType === 'free' ? '720p' : '1080p';
      const resolution = quality === '720p' ? '720x1280' : '1080x1920'; // TikTok aspect ratio (9:16)
      const videoBitrate = quality === '720p' ? '2000k' : '4000k';
      
      let command = ffmpeg(inputPath)
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
          '-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black'
        ]);
      
      // Add watermark for free users
      if (subscriptionType === 'free') {
        command = command.outputOptions([
          `-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='@VideoShortsBot':fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5:boxborderw=3:x=10:y=H-th-10`
        ]);
      }
      
      command
        .on('start', (cmd) => {
          console.log(`Optimizing TikTok video: ${cmd.substring(0, 100)}...`);
        })
        .on('end', () => {
          console.log(`TikTok video optimization completed: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          reject(new Error(`TikTok video optimization failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async extractTikTokSegment(inputPath, outputPath, startTime, duration, subscriptionType) {
    return new Promise((resolve, reject) => {
      const quality = subscriptionType === 'free' ? '720p' : '1080p';
      const resolution = quality === '720p' ? '720x1280' : '1080x1920';
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
          '-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black'
        ]);
      
      // Add watermark for free users
      if (subscriptionType === 'free') {
        command = command.outputOptions([
          `-vf scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='@VideoShortsBot':fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5:boxborderw=3:x=10:y=H-th-10`
        ]);
      }
      
      command
        .on('start', (cmd) => {
          console.log(`Extracting TikTok segment: ${cmd.substring(0, 100)}...`);
        })
        .on('progress', (progress) => {
          if (progress.percent && progress.percent % 25 === 0) {
            console.log(`TikTok segment progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`TikTok segment extraction completed: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          reject(new Error(`TikTok segment extraction failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  enhanceTikTokError(error, processingId, videoUrl) {
    const message = error.message.toLowerCase();
    
    if (message.includes('private') || message.includes('not accessible')) {
      return new Error('This TikTok video is private or has restricted access. Please try a different video.');
    } else if (message.includes('deleted') || message.includes('not found')) {
      return new Error('This TikTok video has been deleted or is no longer available.');
    } else if (message.includes('region') || message.includes('blocked')) {
      return new Error('This TikTok video is not available in your region.');
    } else if (message.includes('download url') || message.includes('extract')) {
      return new Error('Unable to process this TikTok video. It may be private or have restricted access.');
    } else if (message.includes('timeout') || message.includes('network')) {
      return new Error('Network timeout while processing TikTok video. Please try again.');
    } else if (message.includes('too short')) {
      return new Error('TikTok video is too short for processing (minimum 3 seconds required).');
    } else if (message.includes('forbidden') || message.includes('403')) {
      return new Error('Access to this TikTok video is restricted. Please try a different video.');
    } else {
      return new Error(`TikTok video processing failed: ${error.message}`);
    }
  }
}

module.exports = TikTokProcessor;