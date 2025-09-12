// config/youtube-bot-avoidance.js - Enhanced bot detection avoidance
const { EventEmitter } = require('events');

class RateLimiter extends EventEmitter {
  constructor(config) {
    super();
    this.config = config.rateLimiting;
    this.requestHistory = new Map();
    this.globalBackoff = 0;
    this.consecutiveFailures = 0;
  }

  async checkRateLimit(url) {
    const domain = this.extractDomain(url);
    const now = Date.now();
    const history = this.requestHistory.get(domain) || [];
    
    // Clean old entries
    const validHistory = history.filter(time => now - time < this.config.windowMs);
    
    // Apply global backoff
    if (this.globalBackoff > now) {
      const waitTime = this.globalBackoff - now;
      throw new Error(`Global rate limit active. Wait ${Math.ceil(waitTime / 1000)} seconds.`);
    }
    
    // Check request count in window
    if (validHistory.length >= this.config.maxRequests) {
      const waitTime = this.config.windowMs - (now - validHistory[0]);
      throw new Error(`Rate limit exceeded for ${domain}. Wait ${Math.ceil(waitTime / 1000)} seconds.`);
    }
    
    // Apply exponential backoff for consecutive failures
    if (this.consecutiveFailures > 0) {
      const backoffTime = Math.min(
        this.config.maxBackoffTime,
        this.config.baseBackoffTime * Math.pow(2, this.consecutiveFailures)
      );
      
      if (validHistory.length > 0 && now - validHistory[validHistory.length - 1] < backoffTime) {
        const waitTime = backoffTime - (now - validHistory[validHistory.length - 1]);
        throw new Error(`Exponential backoff active. Wait ${Math.ceil(waitTime / 1000)} seconds.`);
      }
    }
    
    // Record this request
    validHistory.push(now);
    this.requestHistory.set(domain, validHistory);
    
    this.emit('requestAllowed', { domain, timestamp: now });
    return true;
  }

  recordFailure(error) {
    this.consecutiveFailures++;
    
    if (this.isBotDetectionError(error)) {
      // Activate global backoff for bot detection
      const backoffTime = Math.min(
        this.config.maxGlobalBackoff,
        this.config.botDetectionBackoff * Math.pow(2, Math.min(this.consecutiveFailures, 5))
      );
      
      this.globalBackoff = Date.now() + backoffTime;
      this.emit('botDetectionTriggered', { backoffTime, failures: this.consecutiveFailures });
    }
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.globalBackoff = 0;
    this.emit('requestSucceeded');
  }

  extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  isBotDetectionError(error) {
    const message = error.message.toLowerCase();
    return message.includes('sign in to confirm') ||
           message.includes('bot') ||
           message.includes('verify') ||
           message.includes('captcha') ||
           message.includes('blocked') ||
           message.includes('403') ||
           message.includes('429');
  }
}

class YouTubeErrorHandler {
  constructor(config) {
    this.config = config.errorHandling;
    this.errorCounts = new Map();
    this.circuitBreakerState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.circuitBreakerOpenTime = 0;
  }

  async handleError(error, attempt) {
    const errorType = this.categorizeError(error);
    
    // Update error counts
    const count = this.errorCounts.get(errorType) || 0;
    this.errorCounts.set(errorType, count + 1);
    
    // Check circuit breaker
    if (this.circuitBreakerState === 'OPEN') {
      const now = Date.now();
      if (now - this.circuitBreakerOpenTime > this.config.circuitBreakerTimeout) {
        this.circuitBreakerState = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN. Service temporarily unavailable.');
      }
    }
    
    // Handle specific error types
    switch (errorType) {
      case 'bot_detection':
        return await this.handleBotDetection(error, attempt);
      
      case 'rate_limit':
        return await this.handleRateLimit(error, attempt);
      
      case 'network_timeout':
        return await this.handleNetworkTimeout(error, attempt);
      
      case 'video_unavailable':
        throw new Error('Video is unavailable or private');
      
      case 'age_restricted':
        throw new Error('Video is age-restricted');
      
      case 'region_blocked':
        throw new Error('Video is blocked in your region');
      
      default:
        if (attempt >= this.config.maxRetries) {
          this.openCircuitBreaker();
          throw error;
        }
        
        const delay = this.calculateBackoffDelay(attempt);
        return { shouldRetry: true, waitTime: delay, errorType };
    }
  }

  async handleBotDetection(error, attempt) {
    if (attempt >= this.config.maxBotDetectionRetries) {
      this.openCircuitBreaker();
      throw new Error('YouTube bot detection: Maximum retries exceeded. Please try again later.');
    }
    
    // Aggressive backoff for bot detection
    const baseDelay = this.config.botDetectionBackoff;
    const jitter = Math.random() * 0.3 + 0.85; // 85-115% of base delay
    const waitTime = Math.min(
      this.config.maxBotDetectionBackoff,
      baseDelay * Math.pow(2, attempt) * jitter
    );
    
    return {
      shouldRetry: true,
      waitTime,
      errorType: 'bot_detection',
      message: `Bot detection triggered. Waiting ${Math.ceil(waitTime / 1000)}s before retry ${attempt + 1}`
    };
  }

  async handleRateLimit(error, attempt) {
    if (attempt >= this.config.maxRetries) {
      throw new Error('Rate limit: Maximum retries exceeded');
    }
    
    // Extract wait time from error if available
    let waitTime = this.config.rateLimitBackoff;
    const retryAfterMatch = error.message.match(/retry after (\d+)/i);
    if (retryAfterMatch) {
      waitTime = parseInt(retryAfterMatch[1]) * 1000;
    }
    
    return {
      shouldRetry: true,
      waitTime: Math.min(waitTime, this.config.maxRateLimitBackoff),
      errorType: 'rate_limit'
    };
  }

  async handleNetworkTimeout(error, attempt) {
    if (attempt >= this.config.maxRetries) {
      throw new Error('Network timeout: Maximum retries exceeded');
    }
    
    const waitTime = this.calculateBackoffDelay(attempt);
    return {
      shouldRetry: true,
      waitTime,
      errorType: 'network_timeout'
    };
  }

  categorizeError(error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('sign in to confirm') || 
        message.includes('bot') || 
        message.includes('verify')) {
      return 'bot_detection';
    } else if (message.includes('rate limit') || 
               message.includes('429') || 
               message.includes('quota exceeded')) {
      return 'rate_limit';
    } else if (message.includes('timeout') || 
               message.includes('network') ||
               message.includes('econnreset')) {
      return 'network_timeout';
    } else if (message.includes('video unavailable') || 
               message.includes('private')) {
      return 'video_unavailable';
    } else if (message.includes('age-restricted') || 
               message.includes('age_restricted')) {
      return 'age_restricted';
    } else if (message.includes('region') || 
               message.includes('blocked')) {
      return 'region_blocked';
    } else if (message.includes('403')) {
      return 'forbidden';
    } else if (message.includes('404')) {
      return 'not_found';
    } else if (message.includes('500') || 
               message.includes('502') || 
               message.includes('503')) {
      return 'server_error';
    } else {
      return 'unknown';
    }
  }

  calculateBackoffDelay(attempt) {
    const baseDelay = this.config.baseBackoffDelay;
    const maxDelay = this.config.maxBackoffDelay;
    const jitter = Math.random() * 0.3 + 0.85; // Add jitter to prevent thundering herd
    
    return Math.min(maxDelay, baseDelay * Math.pow(2, attempt) * jitter);
  }

  openCircuitBreaker() {
    this.circuitBreakerState = 'OPEN';
    this.circuitBreakerOpenTime = Date.now();
  }

  reset() {
    this.errorCounts.clear();
    this.circuitBreakerState = 'CLOSED';
    this.circuitBreakerOpenTime = 0;
  }

  getStats() {
    return {
      errorCounts: Object.fromEntries(this.errorCounts),
      circuitBreakerState: this.circuitBreakerState,
      circuitBreakerOpenTime: this.circuitBreakerOpenTime
    };
  }
}

class ProxyRotator {
  constructor(proxies = []) {
    this.proxies = proxies;
    this.currentIndex = 0;
    this.failedProxies = new Set();
    this.proxyStats = new Map();
  }

  getNextProxy() {
    if (this.proxies.length === 0) return null;
    
    let attempts = 0;
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      
      if (!this.failedProxies.has(proxy)) {
        return proxy;
      }
      
      attempts++;
    }
    
    return null; // All proxies failed
  }

  markProxyFailed(proxy) {
    this.failedProxies.add(proxy);
    const stats = this.proxyStats.get(proxy) || { failures: 0, lastFailure: 0 };
    stats.failures++;
    stats.lastFailure = Date.now();
    this.proxyStats.set(proxy, stats);
  }

  markProxySuccessful(proxy) {
    this.failedProxies.delete(proxy);
    const stats = this.proxyStats.get(proxy) || { failures: 0, lastFailure: 0 };
    stats.failures = Math.max(0, stats.failures - 1);
    this.proxyStats.set(proxy, stats);
  }

  resetFailedProxies() {
    // Reset proxies that failed more than 5 minutes ago
    const now = Date.now();
    const resetThreshold = 5 * 60 * 1000; // 5 minutes
    
    for (const [proxy, stats] of this.proxyStats.entries()) {
      if (now - stats.lastFailure > resetThreshold) {
        this.failedProxies.delete(proxy);
      }
    }
  }
}

// Configuration object
const youtubeBotAvoidanceConfig = {
  rateLimiting: {
    maxRequests: 5,
    windowMs: 60000, // 1 minute
    baseBackoffTime: 5000, // 5 seconds
    maxBackoffTime: 300000, // 5 minutes
    botDetectionBackoff: 30000, // 30 seconds
    maxGlobalBackoff: 1800000 // 30 minutes
  },
  
  errorHandling: {
    maxRetries: 3,
    maxBotDetectionRetries: 5,
    baseBackoffDelay: 2000, // 2 seconds
    maxBackoffDelay: 60000, // 1 minute
    botDetectionBackoff: 15000, // 15 seconds
    maxBotDetectionBackoff: 300000, // 5 minutes
    rateLimitBackoff: 10000, // 10 seconds
    maxRateLimitBackoff: 120000, // 2 minutes
    circuitBreakerTimeout: 300000 // 5 minutes
  },
  
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
  ],
  
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0'
  }
};

module.exports = {
  RateLimiter,
  YouTubeErrorHandler,
  ProxyRotator,
  youtubeBotAvoidanceConfig
};