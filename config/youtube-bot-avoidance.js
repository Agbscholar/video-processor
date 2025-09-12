// config/youtube-bot-avoidance.js - Additional configuration for bot detection avoidance

const youtubeBotAvoidanceConfig = {
  // Rate limiting to avoid being flagged
  rateLimiting: {
    maxRequestsPerMinute: 10,
    maxRequestsPerHour: 300,
    cooldownPeriod: 60000, // 1 minute
    backoffMultiplier: 2,
    maxBackoffTime: 300000 // 5 minutes
  },

  // Enhanced user agent rotation
  userAgents: [
    // Chrome on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    
    // Chrome on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    
    // Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
    
    // Safari
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    
    // Edge
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
  ],

  // Headers that make requests look more human
  humanHeaders: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,fr;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'DNT': '1'
  },

  // Referrers to use for requests
  referrers: [
    'https://www.google.com/',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
    'https://www.youtube.com/',
    'https://www.reddit.com/',
    'https://twitter.com/'
  ],

  // Download options for different tools
  downloadOptions: {
    youtubeDl: {
      maxFileSize: '100M',
      socketTimeout: 30,
      retries: 5,
      fragmentRetries: 10,
      skipUnavailableFragments: true,
      keepFragments: false,
      bufferSize: '16K',
      httpChunkSize: '10M',
      // Simulate slower connection
      limitRate: '3M',
      // Random sleep between requests
      sleepInterval: 2,
      maxSleepInterval: 10,
      // Use cookies from browser if available
      cookiesFromBrowser: 'chrome',
      // Additional options
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      extractFlat: false,
      writeDescription: false,
      writeInfoJson: false,
      writeThumbnail: false,
      writeAnnotations: false
    },
    
    ytdlCore: {
      quality: 'highest',
      filter: 'audioandvideo',
      highWaterMark: 1024 * 1024, // 1MB
      dlChunkSize: 1024 * 1024 * 2, // 2MB
      requestOptions: {
        timeout: 30000,
        maxRedirects: 5,
        maxRetries: 3,
        retryDelay: 1000
      }
    },

    distube: {
      quality: 'highest',
      filter: 'audioandvideo',
      highWaterMark: 1024 * 1024,
      dlChunkSize: 1024 * 1024 * 2
    }
  },

  // Timing configurations
  delays: {
    betweenRequests: {
      min: 2000,
      max: 8000
    },
    afterBotDetection: {
      min: 15000,
      max: 30000
    },
    beforeRetry: {
      min: 5000,
      max: 15000
    }
  },

  // Error patterns that indicate bot detection
  botDetectionPatterns: [
    'sign in to confirm',
    'verify you\'re not a bot',
    'captcha',
    'blocked',
    'forbidden',
    '403',
    '429',
    'too many requests',
    'rate limit',
    'quota exceeded',
    'service unavailable',
    'temporarily unavailable'
  ],

  // Proxy configuration (if using proxies)
  proxy: {
    enabled: false, // Set to true if you have proxies
    rotation: true,
    timeout: 30000,
    retries: 3,
    list: [
      // Add your proxy list here
      // 'http://proxy1:port',
      // 'http://proxy2:port'
    ]
  }
};

// Rate limiting implementation
class RateLimiter {
  constructor(config) {
    this.config = config.rateLimiting;
    this.requests = new Map(); // domain -> { count, firstRequest, blocked }
    this.globalRequests = [];
  }

  async checkRateLimit(domain = 'youtube.com') {
    const now = Date.now();
    const domainData = this.requests.get(domain) || { count: 0, firstRequest: now, blocked: false };

    // Clean old requests
    this.globalRequests = this.globalRequests.filter(time => now - time < 3600000); // 1 hour
    
    // Check if domain is temporarily blocked
    if (domainData.blocked && now - domainData.firstRequest < this.config.cooldownPeriod) {
      const waitTime = this.config.cooldownPeriod - (now - domainData.firstRequest);
      throw new Error(`Rate limited. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
    }

    // Reset if cooldown period has passed
    if (domainData.blocked && now - domainData.firstRequest >= this.config.cooldownPeriod) {
      domainData.blocked = false;
      domainData.count = 0;
      domainData.firstRequest = now;
    }

    // Check hourly limit
    if (this.globalRequests.length >= this.config.maxRequestsPerHour) {
      throw new Error('Hourly request limit exceeded. Please wait before making more requests.');
    }

    // Check per-minute limit
    const minuteRequests = this.globalRequests.filter(time => now - time < 60000);
    if (minuteRequests.length >= this.config.maxRequestsPerMinute) {
      domainData.blocked = true;
      this.requests.set(domain, domainData);
      throw new Error('Per-minute request limit exceeded. Cooling down...');
    }

    // Record request
    this.globalRequests.push(now);
    domainData.count++;
    this.requests.set(domain, domainData);

    // Add small delay between requests
    const delay = Math.random() * 2000 + 1000; // 1-3 seconds
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// Enhanced error handler
class YouTubeErrorHandler {
  constructor(config) {
    this.config = config;
    this.consecutiveErrors = 0;
    this.lastErrorTime = 0;
  }

  isBotDetection(error) {
    const errorMessage = error.message.toLowerCase();
    return this.config.botDetectionPatterns.some(pattern => 
      errorMessage.includes(pattern)
    );
  }

  async handleError(error, attempt = 1) {
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();

    if (this.isBotDetection(error)) {
      const waitTime = Math.min(
        this.config.delays.afterBotDetection.min * Math.pow(2, attempt - 1),
        this.config.delays.afterBotDetection.max
      );
      
      console.log(`Bot detection encountered. Waiting ${waitTime / 1000}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      return {
        shouldRetry: attempt < 3,
        waitTime,
        errorType: 'bot_detection'
      };
    }

    const waitTime = Math.min(
      this.config.delays.beforeRetry.min * Math.pow(2, attempt - 1),
      this.config.delays.beforeRetry.max
    );

    await new Promise(resolve => setTimeout(resolve, waitTime));

    return {
      shouldRetry: attempt < 5,
      waitTime,
      errorType: 'general'
    };
  }

  reset() {
    this.consecutiveErrors = 0;
    this.lastErrorTime = 0;
  }
}

// Helper functions
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomUserAgent() {
  const agents = youtubeBotAvoidanceConfig.userAgents;
  return agents[Math.floor(Math.random() * agents.length)];
}

function getRandomReferrer() {
  const referrers = youtubeBotAvoidanceConfig.referrers;
  return referrers[Math.floor(Math.random() * referrers.length)];
}

function buildHumanHeaders(userAgent = null, referrer = null) {
  return {
    ...youtubeBotAvoidanceConfig.humanHeaders,
    'User-Agent': userAgent || getRandomUserAgent(),
    'Referer': referrer || getRandomReferrer()
  };
}

module.exports = {
  youtubeBotAvoidanceConfig,
  RateLimiter,
  YouTubeErrorHandler,
  getRandomDelay,
  getRandomUserAgent,
  getRandomReferrer,
  buildHumanHeaders
};