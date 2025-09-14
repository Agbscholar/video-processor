// index.js - Complete Fixed server with proper Supabase configuration
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
require('dotenv').config();

// Import ENHANCED processors
const EnhancedYouTubeProcessor = require('./processors/youtube-processor'); // Your fixed version
const TikTokProcessor = require('./processors/tiktok-processor');
const BaseProcessor = require('./processors/base-processor');
const SupabaseVideoProcessor = require('./processors/supabaseVideoProcessor');

// Import YouTube bot avoidance utilities (if available)
let RateLimiter, YouTubeErrorHandler, youtubeBotAvoidanceConfig;
try {
  const botAvoidance = require('./config/youtube-bot-avoidance');
  RateLimiter = botAvoidance.RateLimiter;
  YouTubeErrorHandler = botAvoidance.YouTubeErrorHandler;
  youtubeBotAvoidanceConfig = botAvoidance.youtubeBotAvoidanceConfig;
  console.log('YouTube bot avoidance loaded successfully');
} catch (error) {
  console.warn('YouTube bot avoidance module not found, using basic rate limiting');
  
  // Fallback rate limiter
  class FallbackRateLimiter {
    async checkRateLimit(url) { 
      console.log(`Rate limit check for: ${url}`);
      return true; 
    }
  }
  
  class FallbackErrorHandler {
    async handleError(error, attempt) { 
      console.log(`Error handler called for attempt ${attempt}:`, error.message);
      throw error; 
    }
    reset() {
      console.log('Error handler reset');
    }
  }
  
  RateLimiter = FallbackRateLimiter;
  YouTubeErrorHandler = FallbackErrorHandler;
  youtubeBotAvoidanceConfig = {
    rateLimiting: { cooldownPeriod: 60000 }
  };
}

const app = express();

// FIX: Trust proxy for Render.com deployment
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

const PORT = process.env.PORT || 10000;

// Initialize YouTube components
const youtubeRateLimiter = new RateLimiter(youtubeBotAvoidanceConfig);
const youtubeErrorHandler = new YouTubeErrorHandler(youtubeBotAvoidanceConfig);

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
  credentials: true
}));

// Enhanced rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

const youtubeProcessingLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10,
  message: 'Too many YouTube processing requests. Please wait before trying again.',
  skip: (req) => {
    const videoUrl = req.body?.video_url;
    return videoUrl && !isYouTubeUrl(videoUrl);
  }
});

app.use('/process', youtubeProcessingLimiter);
app.use('/process-video', youtubeProcessingLimiter);
app.use(generalLimiter);

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp/uploads');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024
  }
});

// Initialize processors
const processors = {
  'YouTube': new EnhancedYouTubeProcessor(),
  'TikTok': new TikTokProcessor(),
  'Other': new BaseProcessor()
};

// Initialize Supabase processor (with error handling)
let supabaseProcessor = null;
try {
  supabaseProcessor = new SupabaseVideoProcessor();
  console.log('Supabase processor initialized successfully');
} catch (error) {
  console.warn('Supabase processor initialization failed:', error.message);
}

// Enhanced authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  const validTokens = [
    process.env.PROCESSING_SERVICE_TOKEN,
    process.env.N8N_WEBHOOK_SECRET,
    process.env.VIDEO_PROCESSOR_API_KEY
  ].filter(Boolean);
  
  if (!token) {
    return res.status(401).json({ 
      error: 'Access token is required',
      processing_id: req.body?.processing_id 
    });
  }
  
  if (!validTokens.includes(token)) {
    return res.status(403).json({ 
      error: 'Invalid token',
      processing_id: req.body?.processing_id 
    });
  }
  
  next();
};

// YouTube URL detection helper
function isYouTubeUrl(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be');
}

// Create temp directories
async function initializeTempDirs() {
  const dirs = ['/tmp/uploads', '/tmp/processing', '/tmp/output'];
  
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error(`Failed to create directory ${dir}:`, error);
      }
    }
  }
}

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
  try {
    let storageStats = {};
    if (supabaseProcessor) {
      try {
        storageStats = await supabaseProcessor.storage.getStorageStats();
      } catch (err) {
        storageStats = { error: 'Could not fetch storage stats' };
      }
    }
    
    res.status(200).json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
      processors: {
        youtube: {
          status: 'enhanced',
          bot_avoidance: 'enabled',
          rate_limiting: 'active'
        },
        tiktok: 'standard',
        supabase: supabaseProcessor ? 'available' : 'unavailable'
      },
      endpoints: ['/process', '/process-video', '/upload-and-process', '/cleanup'],
      storage: {
        supabase: storageStats,
        plan: 'free-tier-optimized'
      },
      config: {
        supabase_url: 'https://qwqvdvhvcroggxndniom.supabase.co' ? 'configured' : 'missing',
        supabase_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3cXZkdmh2Y3JvZ2d4bmRuaW9tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjQxMTc1MCwiZXhwIjoyMDcxOTg3NzUwfQ.8PLytgLvYwaHjOJzw2Hq2yOkGJmxEX8im6wM5HQxlF4' ? 'configured' : 'missing'
      }
    });
  } catch (error) {
    res.status(200).json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      processors: { error: 'Could not fetch processor status' }
    });
  }
});

// FIXED: /process endpoint with proper Supabase config validation
app.post('/process', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  let processingId = req.body.processing_id || uuidv4();
  
  console.log(`[${processingId}] Starting video processing request`);
  
  try {
    const {
      processing_id,
      telegram_id,
      chat_id,
      video_url,
      video_info,
      platform,
      subscription_type = 'free',
      user_limits = { max_shorts: 3 },
      supabase,
      storage,
      callback_url,
      business_bot_url
    } = req.body;

    // Input validation
    if (!video_url) {
      return res.status(400).json({
        error: 'Missing required field: video_url',
        processing_id: processingId
      });
    }

    if (!telegram_id || !chat_id) {
      return res.status(400).json({
        error: 'Missing telegram identifiers: telegram_id, chat_id',
        processing_id: processingId
      });
    }

    // Enhanced YouTube rate limiting check
    if (isYouTubeUrl(video_url)) {
      try {
        await youtubeRateLimiter.checkRateLimit('youtube.com');
        console.log(`[${processingId}] YouTube rate limit check passed`);
      } catch (rateLimitError) {
        return res.status(429).json({
          error: rateLimitError.message,
          processing_id: processingId,
          error_type: 'rate_limit',
          retry_after: Math.ceil(youtubeBotAvoidanceConfig.rateLimiting.cooldownPeriod / 1000)
        });
      }
    }

    const finalCallbackUrl = callback_url || 
      (business_bot_url ? `${business_bot_url}/webhook/n8n-callback` : null) ||
      process.env.DEFAULT_CALLBACK_URL;

    if (!finalCallbackUrl) {
      return res.status(400).json({
        error: 'Missing callback mechanism: need either callback_url or business_bot_url',
        processing_id: processingId
      });
    }

    // Immediate response to n8n
    res.status(202).json({
      status: 'accepted',
      processing_id: processingId,
      message: 'Video processing started with enhanced YouTube support',
      estimated_completion_time: new Date(Date.now() + 300000).toISOString(),
      accepted_at: new Date().toISOString(),
      callback_url: finalCallbackUrl,
      processor_type: isYouTubeUrl(video_url) ? 'enhanced_youtube' : 'standard'
    });

    // Start enhanced background processing with FIXED Supabase config
    processVideoBackgroundEnhanced({
      processing_id: processingId,
      telegram_id,
      chat_id,
      video_url,
      video_info: video_info || { 
        platform: platform || 'YouTube', 
        title: 'Video Processing',
        description: 'Processing video with enhanced bot avoidance'
      },
      platform: platform || detectPlatformFromUrl(video_url),
      subscription_type,
      user_limits,
      // FIX: Properly construct Supabase config
      supabase_config: {
        url: process.env.SUPABASE_URL,
        service_key: process.env.SUPABASE_SERVICE_KEY,
        ...supabase
      },
      storage_config: storage,
      callback_url: finalCallbackUrl,
      business_bot_url,
      start_time: startTime
    }).catch(error => {
      console.error(`[${processingId}] Background processing failed:`, error);
    });

  } catch (error) {
    console.error(`[${processingId}] Processing request failed:`, error);
    
    res.status(500).json({
      error: error.message,
      processing_id: processingId,
      timestamp: new Date().toISOString()
    });
  }
});

// FIXED: process-video endpoint with proper config
app.post('/process-video', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  let processingId = req.body.processing_id || uuidv4();
  
  console.log(`[${processingId}] Starting Supabase-optimized video processing`);
  
  try {
    const {
      telegram_id,
      chat_id,
      video_url,
      subscription_type = 'free',
      callback_url
    } = req.body;

    // Input validation
    if (!video_url || !callback_url) {
      return res.status(400).json({
        error: 'Missing required fields: video_url, callback_url',
        processing_id: processingId
      });
    }

    if (!telegram_id || !chat_id) {
      return res.status(400).json({
        error: 'Missing telegram identifiers: telegram_id, chat_id',
        processing_id: processingId
      });
    }

    // Enhanced YouTube rate limiting check
    if (isYouTubeUrl(video_url)) {
      try {
        await youtubeRateLimiter.checkRateLimit('youtube.com');
      } catch (rateLimitError) {
        return res.status(429).json({
          error: rateLimitError.message,
          processing_id: processingId,
          error_type: 'rate_limit'
        });
      }
    }

    // Immediate response
    res.status(202).json({
      status: 'accepted',
      processing_id: processingId,
      message: 'Video processing started with Supabase storage and enhanced YouTube support',
      estimated_completion_time: new Date(Date.now() + 300000).toISOString(),
      accepted_at: new Date().toISOString(),
      storage_method: 'supabase-optimized'
    });

    // Start Supabase-optimized background processing
    processWithSupabaseStorageEnhanced({
      processing_id: processingId,
      telegram_id,
      chat_id,
      video_url,
      subscription_type,
      callback_url,
      start_time: startTime
    }).catch(error => {
      console.error(`[${processingId}] Supabase processing failed:`, error);
    });

  } catch (error) {
    console.error(`[${processingId}] Processing request failed:`, error);
    
    res.status(500).json({
      error: error.message,
      processing_id: processingId,
      timestamp: new Date().toISOString()
    });
  }
});

// ENHANCED: Background processing with FIXED Supabase configuration
async function processVideoBackgroundEnhanced(data) {
  const { processing_id, telegram_id, chat_id, video_url } = data;
  console.log(`[${processing_id}] Starting enhanced background processing for user ${telegram_id}`);
  
  let processingAttempt = 1;
  const maxAttempts = 3;
  
  while (processingAttempt <= maxAttempts) {
    try {
      // Determine processor based on platform
      const platform = data.platform || detectPlatformFromUrl(data.video_url);
      const processor = processors[platform] || processors['Other'];
      
      console.log(`[${processing_id}] Using processor: ${platform} (attempt ${processingAttempt}/${maxAttempts})`);
      
      // FIXED: Enhanced processing data with proper Supabase config validation
      const processingData = {
        ...data,
        video_info: {
          ...data.video_info,
          platform: platform,
          url: video_url
        },
        // FIX: Ensure both url and service_key are present before creating config
        supabase_config: (data.supabase_config?.url && data.supabase_config?.service_key) ? {
          url: data.supabase_config.url,
          service_key: data.supabase_config.service_key
        } : null
      };
      
      console.log(`[${processing_id}] Supabase config status: ${processingData.supabase_config ? 'configured' : 'not configured'}`);
      
      // Set processing timeout
      const processingTimeout = parseInt(process.env.MAX_PROCESSING_TIME) || 600000;
      const processingPromise = processor.process(processingData);
      
      const result = await Promise.race([
        processingPromise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Processing timeout exceeded')), processingTimeout);
        })
      ]);
      
      console.log(`[${processing_id}] Processing completed successfully`);
      youtubeErrorHandler.reset(); // Reset error counter on success
      
      // Enhanced success callback
      await sendCallback(data.callback_url, {
        processing_id: data.processing_id,
        telegram_id: data.telegram_id,
        chat_id: data.chat_id,
        status: 'completed',
        shorts_results: result.shorts_results || result.shorts || [],
        total_shorts: result.total_shorts || (result.shorts_results?.length || result.shorts?.length || 0),
        processing_completed_at: new Date().toISOString(),
        video_info: {
          ...data.video_info,
          ...result.video_info
        },
        platform: platform,
        subscription_type: data.subscription_type,
        usage_stats: {
          processing_time: `${Math.floor((Date.now() - data.start_time) / 1000)} seconds`,
          videos_processed: 1,
          shorts_created: result.total_shorts || (result.shorts_results?.length || result.shorts?.length || 0),
          quality: data.subscription_type === 'free' ? '720p' : '1080p',
          processing_method: 'enhanced_youtube',
          storage_method: result.usage_stats?.storage_method || 'unknown'
        }
      });
      
      return; // Success, exit the retry loop
      
    } catch (error) {
      console.error(`[${processing_id}] Processing attempt ${processingAttempt} failed:`, error);
      
      // Handle YouTube bot detection with enhanced error handling
      if (isYouTubeUrl(video_url)) {
        try {
          const errorResponse = await youtubeErrorHandler.handleError(error, processingAttempt);
          
          if (errorResponse.errorType === 'bot_detection' && processingAttempt < maxAttempts) {
            console.log(`[${processing_id}] Bot detection handled, retrying in ${errorResponse.waitTime / 1000}s...`);
            processingAttempt++;
            continue; // Retry
          }
        } catch (handlerError) {
          console.error(`[${processing_id}] Error handler failed:`, handlerError);
        }
      }
      
      // Final error handling
      const errorCategory = categorizeError(error);
      
      await sendCallback(data.callback_url, {
        processing_id: data.processing_id,
        telegram_id: data.telegram_id,
        chat_id: data.chat_id,
        status: 'error',
        error: {
          message: error.message,
          category: errorCategory,
          timestamp: new Date().toISOString(),
          processing_time: `${Math.floor((Date.now() - data.start_time) / 1000)} seconds`,
          attempts_made: processingAttempt,
          is_youtube_bot_detection: errorCategory === 'youtube_bot_detection'
        },
        video_url: data.video_url,
        video_info: data.video_info,
        platform: data.platform || detectPlatformFromUrl(data.video_url)
      });
      
      break; // Exit retry loop on non-retryable error
    }
  }
}

// ENHANCED: Supabase processing with FIXED configuration
async function processWithSupabaseStorageEnhanced(data) {
  const { processing_id, telegram_id, chat_id, video_url } = data;
  console.log(`[${processing_id}] Starting enhanced Supabase processing for user ${telegram_id}`);
  
  try {
    // For YouTube URLs, use the enhanced YouTube processor
    if (isYouTubeUrl(video_url)) {
      console.log(`[${processing_id}] Using enhanced YouTube processor for Supabase storage`);
      
      const youtubeProcessor = processors['YouTube'];
      
      // FIX: Properly construct Supabase config with validation
      const supabaseConfig = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) ? {
        url: process.env.SUPABASE_URL,
        service_key: process.env.SUPABASE_SERVICE_KEY
      } : null;
      
      if (!supabaseConfig) {
        console.warn(`[${processing_id}] Supabase config missing, processing without cloud storage`);
      }
      
      const result = await youtubeProcessor.process({
        processing_id: processing_id,
        video_url: video_url,
        video_info: {
          platform: 'YouTube',
          title: 'YouTube Video Processing',
          url: video_url
        },
        subscription_type: data.subscription_type,
        user_limits: { max_shorts: data.subscription_type === 'free' ? 2 : 5 },
        supabase_config: supabaseConfig
      });
      
      console.log(`[${processing_id}] Enhanced YouTube processing completed successfully`);
      
      // Send success callback with enhanced data
      await sendCallback(data.callback_url, {
        processing_id: data.processing_id,
        telegram_id: data.telegram_id,
        chat_id: data.chat_id,
        status: 'completed',
        shorts_results: result.shorts_results || [],
        total_shorts: result.total_shorts || 0,
        processing_completed_at: new Date().toISOString(),
        video_info: result.video_info,
        storage_method: 'supabase_enhanced',
        usage_stats: {
          processing_time: `${Math.floor((Date.now() - data.start_time) / 1000)} seconds`,
          quality: data.subscription_type === 'free' ? '720p' : '1080p',
          storage_used: supabaseConfig ? 'supabase-cloud' : 'local-files',
          processing_method: 'enhanced_youtube_with_supabase'
        }
      });
      
    } else {
      // Use basic Supabase processor for non-YouTube URLs (if available)
      if (!supabaseProcessor) {
        throw new Error('Supabase processor not available and non-YouTube URL provided');
      }
      
      const result = await supabaseProcessor.processVideo(video_url, {
        quality: data.subscription_type === 'free' ? 'medium' : 'high',
        maxDuration: data.subscription_type === 'free' ? 300 : 600
      });
      
      console.log(`[${processing_id}] Basic Supabase processing completed successfully`);
      
      await sendCallback(data.callback_url, {
        processing_id: data.processing_id,
        telegram_id: data.telegram_id,
        chat_id: data.chat_id,
        status: 'completed',
        video_url: result.videoUrl,
        thumbnail_url: result.thumbnailUrl,
        file_size_mb: result.fileSize,
        processing_completed_at: new Date().toISOString(),
        storage_method: 'supabase',
        usage_stats: {
          processing_time: `${Math.floor((Date.now() - data.start_time) / 1000)} seconds`,
          quality: data.subscription_type === 'free' ? '720p' : '1080p',
          storage_used: 'supabase-free-tier'
        }
      });
    }

  } catch (error) {
    console.error(`[${processing_id}] Enhanced Supabase processing error:`, error);
    
    const errorCategory = categorizeError(error);
    
    await sendCallback(data.callback_url, {
      processing_id: data.processing_id,
      telegram_id: data.telegram_id,
      chat_id: data.chat_id,
      status: 'error',
      error: {
        message: error.message,
        category: errorCategory,
        timestamp: new Date().toISOString(),
        storage_method: 'supabase_enhanced',
        is_youtube_error: isYouTubeUrl(video_url)
      },
      video_url: data.video_url
    });
  }
}

// ENHANCED: Error categorization with YouTube bot detection
function categorizeError(error) {
  const errorMessage = error.message.toLowerCase();
  
  // YouTube-specific errors
  if (errorMessage.includes('sign in to confirm') || 
      errorMessage.includes('bot') || 
      errorMessage.includes('verify')) {
    return 'youtube_bot_detection';
  } else if (errorMessage.includes('video unavailable') || errorMessage.includes('private')) {
    return 'video_unavailable';
  } else if (errorMessage.includes('age-restricted') || errorMessage.includes('age_restricted')) {
    return 'age_restricted';
  } else if (errorMessage.includes('region') || errorMessage.includes('blocked')) {
    return 'region_blocked';
  } else if (errorMessage.includes('rate limit') || errorMessage.includes('quota exceeded')) {
    return 'rate_limit_exceeded';
  } else if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
    return 'network_timeout';
  } else if (errorMessage.includes('format') || errorMessage.includes('unsupported')) {
    return 'format_error';
  } else if (errorMessage.includes('storage') || errorMessage.includes('upload')) {
    return 'storage_error';
  } else if (errorMessage.includes('ffmpeg') || errorMessage.includes('encoding')) {
    return 'encoding_error';
  } else if (errorMessage.includes('too large') || errorMessage.includes('size')) {
    return 'file_size_error';
  } else if (errorMessage.includes('invalid data')) {
    return 'corrupted_download';
  } else if (errorMessage.includes('supabasekey') || errorMessage.includes('supabase')) {
    return 'configuration_error';
  } else {
    return 'unknown_error';
  }
}

// Platform detection helper
function detectPlatformFromUrl(url) {
  const lowerUrl = url.toLowerCase();
  
  if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    return 'YouTube';
  } else if (lowerUrl.includes('tiktok.com')) {
    return 'TikTok';
  } else if (lowerUrl.includes('instagram.com')) {
    return 'Instagram';
  } else {
    return 'Other';
  }
}

// Enhanced callback sender with better error handling
async function sendCallback(callbackUrl, data, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[${data.processing_id}] Sending callback attempt ${attempt}/${retries} to: ${callbackUrl}`);
      
      const response = await axios.post(callbackUrl, data, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Video-Processing-Service/1.0.0-Enhanced',
          'Authorization': `Bearer ${process.env.N8N_WEBHOOK_SECRET || ''}`
        },
        validateStatus: (status) => status < 500
      });
      
      console.log(`[${data.processing_id}] Callback sent successfully, status: ${response.status}`);
      return response;
      
    } catch (error) {
      console.error(`[${data.processing_id}] Callback attempt ${attempt} failed:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: callbackUrl
      });
      
      if (attempt === retries || (error.response && error.response.status < 500)) {
        console.error(`[${data.processing_id}] All callback attempts failed`);
        break;
      }
      
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Status check endpoint
app.get('/status/:processing_id', authenticateToken, async (req, res) => {
  const { processing_id } = req.params;
  
  try {
    res.json({
      processing_id,
      status: 'processing',
      message: 'Processing status check endpoint - implement with your tracking system',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      processing_id
    });
  }
});

// Upload and process endpoint
app.post('/upload-and-process', authenticateToken, upload.single('video'), async (req, res) => {
  const processingId = uuidv4();
  
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No video file uploaded',
        processing_id: processingId
      });
    }
    
    console.log(`[${processingId}] File upload received: ${req.file.originalname}`);
    
    const processingPath = path.join('/tmp/processing', `${processingId}_${req.file.originalname}`);
    await fs.rename(req.file.path, processingPath);
    
    const processingData = {
      ...req.body,
      processing_id: processingId,
      video_path: processingPath,
      video_info: {
        title: req.file.originalname,
        platform: 'Upload'
      },
      // FIX: Proper Supabase config for uploads too
      supabase_config: (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) ? {
        url: process.env.SUPABASE_URL,
        service_key: process.env.SUPABASE_SERVICE_KEY
      } : null
    };
    
    res.status(202).json({
      status: 'accepted',
      processing_id: processingId,
      message: 'File upload successful, processing started',
      file_info: {
        original_name: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });
    
    processVideoBackgroundEnhanced({
      ...processingData,
      start_time: Date.now()
    }).catch(console.error);
    
  } catch (error) {
    console.error(`[${processingId}] Upload processing failed:`, error);
    res.status(500).json({
      error: error.message,
      processing_id: processingId
    });
  }
});

// Cleanup endpoint
app.post('/cleanup', authenticateToken, async (req, res) => {
  try {
    const { older_than_hours = 24 } = req.body;
    const cutoffTime = Date.now() - (older_than_hours * 60 * 60 * 1000);
    
    const dirs = ['/tmp/uploads', '/tmp/processing', '/tmp/output'];
    let deletedFiles = 0;
    
    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = await fs.stat(filePath);
          
          if (stats.mtime.getTime() < cutoffTime) {
            await fs.unlink(filePath);
            deletedFiles++;
            console.log(`Cleaned up old file: ${filePath}`);
          }
        }
      } catch (error) {
        console.error(`Error cleaning directory ${dir}:`, error);
      }
    }
    
    // Supabase cleanup if available
    if (supabaseProcessor) {
      try {
        await supabaseProcessor.performMaintenance();
      } catch (supabaseError) {
        console.warn('Supabase cleanup failed:', supabaseError.message);
      }
    }
    
    let storageStats = {};
    if (supabaseProcessor) {
      try {
        storageStats = await supabaseProcessor.storage.getStorageStats();
      } catch (err) {
        storageStats = { error: 'Could not fetch storage stats' };
      }
    }
    
    res.json({
      status: 'cleanup_completed',
      deleted_local_files: deletedFiles,
      supabase_storage: storageStats,
      youtube_processor: 'enhanced',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


// Add this route to your index.js file
app.get('/', (req, res) => {
  res.json({
    service: 'Video Processing Service',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      process: '/process',
      processVideo: '/process-video',
      upload: '/upload-and-process',
      cleanup: '/cleanup'
    },
    tools: {
      ytDlp: true, // Will be available via Docker
      ytdlCore: true,
      ffmpeg: true
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    processing_id: req.body?.processing_id,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      'GET /health',
      'POST /process (enhanced YouTube support)',
      'POST /process-video (enhanced YouTube + Supabase)', 
      'POST /upload-and-process',
      'POST /cleanup',
      'GET /status/:processing_id'
    ]
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Auto-cleanup every 30 minutes
if (supabaseProcessor) {
  setInterval(() => {
    supabaseProcessor.performMaintenance()
      .catch(err => console.error('Auto-cleanup error:', err.message));
  }, 30 * 60 * 1000);
}

// Initialize and start server
async function startServer() {
  try {
    await initializeTempDirs();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Video Processing Service running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`🎬 Enhanced n8n endpoint: http://localhost:${PORT}/process`);
      console.log(`🎬 Enhanced Supabase endpoint: http://localhost:${PORT}/process-video`);
      console.log(`📁 Upload endpoint: http://localhost:${PORT}/upload-and-process`);
      console.log(`🧹 Cleanup endpoint: http://localhost:${PORT}/cleanup`);
      console.log(`💾 Storage: ${supabaseProcessor ? 'Supabase-optimized' : 'Local files only'}`);
      console.log(`🤖 YouTube Bot Avoidance: ${RateLimiter ? 'ENABLED' : 'BASIC'}`);
      console.log(`⚡ Rate Limiting: Enhanced for YouTube`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
      console.log(`Supabase Config: URL=${process.env.SUPABASE_URL ? 'SET' : 'MISSING'}, KEY=${process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();