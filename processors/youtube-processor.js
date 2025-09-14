// Enhanced YouTube processor with cookie authentication and proxy support
class YouTubeProcessorEnhanced extends YouTubeProcessor {
  constructor() {
    super();
    this.cookieJar = process.env.YOUTUBE_COOKIES || null;
    this.proxyList = this.loadProxies();
    this.currentProxyIndex = 0;
    this.sessionCookies = new Map();
  }

  loadProxies() {
    const proxies = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(',') : [];
    return proxies.map(proxy => ({
      url: proxy.trim(),
      failed: 0,
      lastUsed: 0
    }));
  }

  getNextProxy() {
    if (this.proxyList.length === 0) return null;
    
    // Find least recently used proxy with fewer failures
    const available = this.proxyList.filter(p => p.failed < 3);
    if (available.length === 0) {
      // Reset failure counts if all proxies failed
      this.proxyList.forEach(p => p.failed = 0);
      return this.proxyList[0];
    }
    
    available.sort((a, b) => a.lastUsed - b.lastUsed);
    const proxy = available[0];
    proxy.lastUsed = Date.now();
    return proxy;
  }

  // Enhanced yt-dlp with cookies and proxy support
  async downloadWithYtDlpEnhanced(videoUrl, processingId) {
    const outputTemplate = path.join(this.tempDir, `${processingId}_original.%(ext)s`);
    const profile = this.getCurrentProfile();
    const proxy = this.getNextProxy();
    
    const options = [
      '--output', outputTemplate,
      '--format', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--socket-timeout', '120',
      '--retries', '2',
      '--user-agent', profile.userAgent,
      '--add-header', `Accept-Language:${profile.acceptLanguage}`,
      '--add-header', `Accept:${profile.accept}`,
      '--extractor-args', 'youtube:player_client=android,web',
      '--throttled-rate', '1M',
      '--sleep-interval', '5',
      '--max-sleep-interval', '15'
    ];

    // Add cookie support
    if (this.cookieJar) {
      if (this.cookieJar.startsWith('{')) {
        // JSON format cookies
        const cookieFile = path.join(this.tempDir, `cookies_${processingId}.json`);
        await fs.writeFile(cookieFile, this.cookieJar);
        options.push('--cookies', cookieFile);
      } else if (this.cookieJar.includes('youtube.com')) {
        // Browser export format
        const cookieFile = path.join(this.tempDir, `cookies_${processingId}.txt`);
        await fs.writeFile(cookieFile, this.cookieJar);
        options.push('--cookies', cookieFile);
      } else {
        // Assume it's a browser name
        options.push('--cookies-from-browser', this.cookieJar);
      }
    }

    // Add proxy support
    if (proxy) {
      options.push('--proxy', proxy.url);
      console.log(`[${processingId}] Using proxy: ${proxy.url}`);
    }

    options.push(videoUrl);

    return new Promise((resolve, reject) => {
      const cmdParts = this.ytDlpCommand.split(' ');
      const process = spawn(cmdParts[0], cmdParts.slice(1).concat(options));
      
      let stderr = '';
      let hasOutput = false;
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        if (data.toString().includes('%') || data.toString().includes('Downloading')) {
          hasOutput = true;
        }
      });

      process.on('close', async (code) => {
        // Cleanup cookie files
        try {
          const cookieFiles = await fs.readdir(this.tempDir);
          for (const file of cookieFiles) {
            if (file.startsWith(`cookies_${processingId}`)) {
              await fs.unlink(path.join(this.tempDir, file)).catch(() => {});
            }
          }
        } catch (e) {}

        if (code === 0) {
          try {
            const files = await fs.readdir(this.tempDir);
            const outputFile = files.find(file => file.startsWith(`${processingId}_original`));
            
            if (!outputFile) {
              reject(new Error('Downloaded file not found'));
              return;
            }
            
            const filePath = path.join(this.tempDir, outputFile);
            console.log(`[${processingId}] yt-dlp enhanced completed: ${outputFile}`);
            resolve(filePath);
          } catch (error) {
            reject(new Error(`File location failed: ${error.message}`));
          }
        } else {
          if (proxy) {
            proxy.failed++;
          }
          
          const errorMsg = stderr || 'yt-dlp process failed';
          
          // Check for specific YouTube errors
          if (stderr.includes('Sign in to confirm')) {
            reject(new Error('Bot detection - cookies required. Set YOUTUBE_COOKIES environment variable.'));
          } else if (stderr.includes('Private video') || stderr.includes('Video unavailable')) {
            reject(new Error('Video is private or unavailable'));
          } else if (stderr.includes('429') || stderr.includes('rate limit')) {
            reject(new Error('Rate limited by YouTube'));
          } else {
            reject(new Error(`yt-dlp failed (code ${code}): ${errorMsg}`));
          }
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
      }, 900000); // 15 minutes timeout
    });
  }

  // Enhanced ytdl-core with session management
  async downloadWithYtdlCoreEnhanced(videoUrl, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
    const profile = this.getCurrentProfile();
    
    // Create session with enhanced headers
    const sessionHeaders = {
      'User-Agent': profile.userAgent,
      'Accept-Language': profile.acceptLanguage,
      'Accept': profile.accept,
      'Accept-Encoding': profile.acceptEncoding,
      'DNT': profile.dnt,
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/'
    };

    // Add session cookies if available
    if (this.sessionCookies.has('youtube')) {
      sessionHeaders['Cookie'] = this.sessionCookies.get('youtube');
    }
    
    return new Promise((resolve, reject) => {
      try {
        const options = {
          quality: 'highestvideo[height<=720]+bestaudio/best[height<=720]/best',
          requestOptions: {
            timeout: 300000,
            headers: sessionHeaders,
            // Add additional anti-detection measures
            transform: (parsed) => {
              // Randomize request timing
              const delay = Math.random() * 2000 + 1000;
              return new Promise(resolve => setTimeout(() => resolve(parsed), delay));
            }
          },
          highWaterMark: 1024 * 1024 * 16
        };

        const stream = ytdl(videoUrl, options);
        const writeStream = fsSync.createWriteStream(outputPath);
        
        stream.pipe(writeStream);
        
        let totalDownloaded = 0;
        let lastProgress = 0;
        let stalled = false;
        let lastProgressTime = Date.now();
        
        stream.on('progress', (chunkLength, downloaded, total) => {
          totalDownloaded = downloaded;
          const now = Date.now();
          
          // Check for stalled downloads
          if (downloaded === lastProgress && now - lastProgressTime > 60000) {
            stalled = true;
            stream.destroy();
            writeStream.destroy();
            reject(new Error('Download stalled'));
            return;
          }
          
          if (total > 0) {
            const percent = Math.round(downloaded / total * 100);
            if (percent - lastProgress >= 20) {
              console.log(`[${processingId}] ytdl-core enhanced progress: ${percent}%`);
              lastProgress = percent;
              lastProgressTime = now;
            }
          }
        });
        
        stream.on('error', (error) => {
          writeStream.destroy();
          const errorMsg = error.message.toLowerCase();
          
          if (errorMsg.includes('410') || errorMsg.includes('gone')) {
            reject(new Error('Video blocked by YouTube (410 Gone)'));
          } else if (errorMsg.includes('403') || errorMsg.includes('forbidden')) {
            reject(new Error('Access forbidden - may need authentication'));
          } else if (errorMsg.includes('429')) {
            reject(new Error('Rate limited by YouTube'));
          } else {
            reject(new Error(`Stream error: ${error.message}`));
          }
        });
        
        writeStream.on('error', (error) => {
          reject(new Error(`Write error: ${error.message}`));
        });
        
        writeStream.on('finish', () => {
          if (!stalled) {
            console.log(`[${processingId}] ytdl-core enhanced completed: ${Math.round(totalDownloaded / 1024 / 1024)}MB`);
            resolve(outputPath);
          }
        });
        
        // Enhanced timeout with stall detection
        setTimeout(() => {
          if (!stalled) {
            stream.destroy();
            writeStream.destroy();
            reject(new Error('ytdl-core enhanced timeout'));
          }
        }, 900000); // 15 minutes
        
      } catch (error) {
        reject(new Error(`ytdl-core enhanced setup failed: ${error.message}`));
      }
    });
  }

  // Alternative: Use Invidious instances as fallback
  async downloadViaInvidious(videoUrl, processingId) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      throw new Error('Cannot extract video ID');
    }

    const invidiousInstances = [
      'https://invidious.fdn.fr',
      'https://inv.tux.pizza',
      'https://invidious.privacydev.net',
      'https://yt.artemislena.eu',
      'https://invidious.flokinet.to'
    ];

    for (const instance of invidiousInstances) {
      try {
        console.log(`[${processingId}] Trying Invidious instance: ${instance}`);
        
        const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
          timeout: 30000,
          headers: {
            'User-Agent': this.getCurrentProfile().userAgent
          }
        });

        const videoData = response.data;
        const formats = videoData.formatStreams || [];
        
        // Find best quality format under 720p
        const suitableFormat = formats
          .filter(f => f.container === 'mp4' && f.resolution && parseInt(f.resolution) <= 720)
          .sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution))[0];

        if (!suitableFormat) {
          continue;
        }

        console.log(`[${processingId}] Found format: ${suitableFormat.resolution}p`);
        
        // Download the video file
        const videoResponse = await axios({
          method: 'get',
          url: suitableFormat.url,
          responseType: 'stream',
          timeout: 600000,
          headers: {
            'User-Agent': this.getCurrentProfile().userAgent,
            'Referer': instance
          }
        });

        const outputPath = path.join(this.tempDir, `${processingId}_original.mp4`);
        const writeStream = fsSync.createWriteStream(outputPath);
        
        return new Promise((resolve, reject) => {
          videoResponse.data.pipe(writeStream);
          
          writeStream.on('finish', () => {
            console.log(`[${processingId}] Invidious download completed`);
            resolve(outputPath);
          });
          
          writeStream.on('error', reject);
          videoResponse.data.on('error', reject);
        });

      } catch (error) {
        console.warn(`[${processingId}] Invidious instance ${instance} failed: ${error.message}`);
        continue;
      }
    }

    throw new Error('All Invidious instances failed');
  }

  // Override the main download method to use enhanced versions
  async downloadVideoSafe(videoUrl, processingId) {
    await this.enforceAdvancedRateLimit();
    
    const methods = [
      () => this.downloadWithYtDlpEnhanced(videoUrl, processingId),
      () => this.downloadWithYtdlCoreEnhanced(videoUrl, processingId),
      () => this.downloadViaInvidious(videoUrl, processingId)
    ];

    let lastError;
    
    for (const [index, method] of methods.entries()) {
      // Skip yt-dlp if not available
      if (index === 0 && !this.availableTools.ytDlp) {
        console.log(`[${processingId}] Skipping yt-dlp enhanced (not available)`);
        continue;
      }
      
      try {
        console.log(`[${processingId}] Enhanced download method ${index + 1}/${methods.length}`);
        
        if (index > 0) {
          await this.enforceAdvancedRateLimit();
        }
        
        const result = await method();
        console.log(`[${processingId}] Enhanced download method ${index + 1} succeeded`);
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[${processingId}] Enhanced download method ${index + 1} failed: ${error.message}`);
        
        await this.cleanupFailedDownload(processingId);
        
        if (index < methods.length - 1) {
          const backoffTime = Math.min(30000 * Math.pow(2, index), 300000); // Exponential backoff, max 5 minutes
          console.log(`[${processingId}] Waiting ${backoffTime/1000}s before next method`);
          await this.sleep(backoffTime);
        }
      }
    }
    
    throw new Error(`All enhanced download methods failed: ${lastError?.message || 'Unknown error'}`);
  }
}

module.exports = YouTubeProcessorEnhanced;