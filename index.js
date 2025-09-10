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
require('dotenv').config();

const YouTubeProcessor = require('./processors/youtube-processor');
const TikTokProcessor = require('./processors/tiktok-processor');
const BaseProcessor = require('./processors/base-processor');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Logging
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
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024 // 500MB
  }
});

// Initialize processors
const processors = {
  'YouTube': new YouTubeProcessor(),
  'TikTok': new TikTokProcessor(),
  'Other': new BaseProcessor()
};

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      error: 'Access token is required',
      processing_id: req.body?.processing_id 
    });
  }
  
  if (token !== process.env.PROCESSING_SERVICE_TOKEN) {
    return res.status(403).json({ 
      error: 'Invalid token',
      processing_id: req.body?.processing_id 
    });
  }
  
  next();
};

// Create temp directories if they don't exist
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Main processing endpoint
app.post('/process-video', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  let processingId = req.body.processing_id || uuidv4();
  
  console.log(`[${processingId}] Starting video processing request`);
  
  try {
    const {
      video_url,
      video_info,
      subscription_type = 'free',
      user_limits = { max_shorts: 3 },
      supabase_config,
      callback_url,
      telegram_id,
      chat_id,
      platform
    } = req.body;

    // Input validation
    if (!video_url || !callback_url) {
      return res.status(400).json({
        error: 'Missing required fields: video_url, callback_url',
        processing_id: processingId
      });
    }

    if (!supabase_config || !supabase_config.url || !supabase_config.service_key) {
      return res.status(400).json({
        error: 'Invalid supabase configuration',
        processing_id: processingId
      });
    }

    // Immediate response to N8N
    res.status(202).json({
      status: 'accepted',
      processing_id: processingId,
      message: 'Video processing started',
      estimated_completion_time: new Date(Date.now() + 300000).toISOString(), // 5 minutes
      accepted_at: new Date().toISOString()
    });

    // Start background processing
    processVideoBackground({
      processing_id: processingId,
      video_url,
      video_info: video_info || { platform: platform || 'YouTube' },
      subscription_type,
      user_limits,
      supabase_config,
      callback_url,
      telegram_id,
      chat_id,
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

// Background processing function
async function processVideoBackground(data) {
  const { processing_id } = data;
  console.log(`[${processing_id}] Starting background processing`);
  
  try {
    // Determine processor based on platform
    const platform = data.video_info.platform || detectPlatformFromUrl(data.video_url);
    const processor = processors[platform] || processors['Other'];
    
    console.log(`[${processing_id}] Using processor: ${platform}`);
    
    // Set processing timeout
    const processingTimeout = parseInt(process.env.MAX_PROCESSING_TIME) || 600000; // 10 minutes
    const processingPromise = processor.process(data);
    
    const result = await Promise.race([
      processingPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Processing timeout')), processingTimeout);
      })
    ]);
    
    console.log(`[${processing_id}] Processing completed successfully`);
    
    // Send success callback to N8N
    await sendCallback(data.callback_url, {
      ...result,
      status: 'completed',
      processing_time: Date.now() - data.start_time
    });

  } catch (error) {
    console.error(`[${processing_id}] Background processing error:`, error);
    
    // Categorize error for better user experience
    const errorCategory = categorizeError(error);
    
    // Send error callback to N8N
    await sendCallback(data.callback_url, {
      processing_id: data.processing_id,
      telegram_id: data.telegram_id,
      chat_id: data.chat_id,
      status: 'failed',
      error: {
        message: error.message,
        category: errorCategory,
        timestamp: new Date().toISOString(),
        processing_time: Date.now() - data.start_time
      },
      video_url: data.video_url,
      platform: platform
    });
  }
}

// Error categorization helper
function categorizeError(error) {
  const errorMessage = error.message.toLowerCase();
  
  if (errorMessage.includes('video unavailable') || errorMessage.includes('private')) {
    return 'video_unavailable';
  } else if (errorMessage.includes('age-restricted') || errorMessage.includes('age_restricted')) {
    return 'age_restricted';
  } else if (errorMessage.includes('region') || errorMessage.includes('blocked')) {
    return 'region_blocked';
  } else if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
    return 'network_timeout';
  } else if (errorMessage.includes('format') || errorMessage.includes('unsupported')) {
    return 'format_error';
  } else if (errorMessage.includes('storage') || errorMessage.includes('upload')) {
    return 'storage_error';
  } else if (errorMessage.includes('ffmpeg') || errorMessage.includes('encoding')) {
    return 'encoding_error';
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

// Callback sender with retry logic
async function sendCallback(callbackUrl, data, retries = 3) {
  const axios = require('axios');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[${data.processing_id}] Sending callback attempt ${attempt}/${retries}`);
      
      const response = await axios.post(callbackUrl, data, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Video-Processing-Service/1.0.0'
        },
        validateStatus: (status) => status < 500 // Don't retry on 4xx errors
      });
      
      console.log(`[${data.processing_id}] Callback sent successfully, status: ${response.status}`);
      return response;
      
    } catch (error) {
      console.error(`[${data.processing_id}] Callback attempt ${attempt} failed:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText
      });
      
      if (attempt === retries || (error.response && error.response.status < 500)) {
        console.error(`[${data.processing_id}] All callback attempts failed or received 4xx error`);
        break;
      }
      
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Status endpoint for checking processing progress
app.get('/status/:processing_id', authenticateToken, async (req, res) => {
  const { processing_id } = req.params;
  
  try {
    // In a real implementation, you'd check processing status from database or cache
    // For now, return a basic response
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

// File upload endpoint (alternative to URL processing)
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
    
    // Move file to processing directory
    const processingPath = path.join('/tmp/processing', `${processingId}_${req.file.originalname}`);
    await fs.rename(req.file.path, processingPath);
    
    // Process the uploaded file
    const processingData = {
      ...req.body,
      processing_id: processingId,
      video_path: processingPath,
      video_info: {
        title: req.file.originalname,
        platform: 'Upload'
      }
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
    
    // Start processing
    processVideoBackground(processingData).catch(console.error);
    
  } catch (error) {
    console.error(`[${processingId}] Upload processing failed:`, error);
    res.status(500).json({
      error: error.message,
      processing_id: processingId
    });
  }
});

// Cleanup endpoint for removing old files
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
    
    res.json({
      status: 'cleanup_completed',
      deleted_files: deletedFiles,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
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
    method: req.method
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

// Initialize and start server
async function startServer() {
  try {
    await initializeTempDirs();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Video Processing Service running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`🎬 Process endpoint: http://localhost:${PORT}/process-video`);
      console.log(`📁 Upload endpoint: http://localhost:${PORT}/upload-and-process`);
      console.log(`🧹 Cleanup endpoint: http://localhost:${PORT}/cleanup`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();