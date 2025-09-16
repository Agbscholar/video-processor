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
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
  credentials: true
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, '/tmp/uploads'),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, AVI, and WebM are allowed.'));
    }
  }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  const validTokens = [
    process.env.PROCESSING_SERVICE_TOKEN,
    process.env.N8N_WEBHOOK_SECRET,
    process.env.VIDEO_PROCESSOR_API_KEY
  ].filter(Boolean);

  if (!token || !validTokens.includes(token)) {
    return res.status(401).json({ error: 'Invalid or missing access token' });
  }
  next();
};

// Initialize temp directories
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
initializeTempDirs();

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const { data } = await supabase.storage.from('video-files').list('', { limit: 1 });
    res.status(200).json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version || '2.2.0',
      storage: {
        supabase: data ? 'available' : 'unavailable',
        plan: 'free-tier-optimized'
      }
    });
  } catch (error) {
    res.status(200).json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      storage: { error: 'Could not fetch storage stats' }
    });
  }
});

// Video upload and processing endpoint
app.post('/upload-and-process', authenticateToken, upload.single('video'), async (req, res) => {
  const processingId = req.body.processing_id || uuidv4();
  const { telegram_id, chat_id, subscription_type = 'free', callback_url } = req.body;

  // Input validation
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded', processing_id: processingId });
  }
  if (!telegram_id || !chat_id) {
    return res.status(400).json({ error: 'Missing telegram_id or chat_id', processing_id: processingId });
  }
  if (!callback_url) {
    return res.status(400).json({ error: 'Missing callback_url', processing_id: processingId });
  }

  // Immediate response
  res.status(202).json({
    status: 'accepted',
    processing_id: processingId,
    message: 'Video processing started',
    estimated_completion_time: new Date(Date.now() + 300000).toISOString(),
    accepted_at: new Date().toISOString(),
    storage_method: 'supabase-optimized'
  });

  // Background processing
  processVideo({
    processing_id: processingId,
    telegram_id,
    chat_id,
    file_path: req.file.path,
    original_filename: req.file.originalname,
    subscription_type,
    callback_url
  }).catch(error => {
    console.error(`[${processingId}] Background processing failed:`, error);
    sendCallback(callback_url, {
      processing_id: processingId,
      telegram_id,
      chat_id,
      status: 'error',
      error: { message: error.message, timestamp: new Date().toISOString() }
    });
  });
});

// Background video processing
async function processVideo(data) {
  const { processing_id, telegram_id, chat_id, file_path, original_filename, subscription_type, callback_url } = data;
  console.log(`[${processing_id}] Starting video processing for user ${telegram_id}`);

  try {
    const outputDir = '/tmp/output';
    const shortPaths = [];
    const maxShorts = subscription_type === 'pro' ? 5 : 3;
    const duration = await getVideoDuration(file_path);

    // Split video into shorts (e.g., 60-second clips)
    const shortDuration = 60;
    const numShorts = Math.min(maxShorts, Math.floor(duration / shortDuration));

    for (let i = 0; i < numShorts; i++) {
      const outputPath = `${outputDir}/${processing_id}_short_${i + 1}.mp4`;
      await new Promise((resolve, reject) => {
        ffmpeg(file_path)
          .setStartTime(i * shortDuration)
          .setDuration(shortDuration)
          .output(outputPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });
      shortPaths.push(outputPath);
    }

    // Upload to Supabase
    const uploadPromises = shortPaths.map(async (path, index) => {
      const fileBuffer = await fs.readFile(path);
      const fileName = `shorts/${processing_id}_short_${index + 1}.mp4`;
      const { publicUrl } = await supabase.storage
        .from('video-files')
        .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true });
      return { url: publicUrl, index: index + 1 };
    });
    const uploadedShorts = await Promise.all(uploadPromises);

    // Generate thumbnail for first short
    const thumbnailPath = `${outputDir}/${processing_id}_thumbnail.jpg`;
    await new Promise((resolve, reject) => {
      ffmpeg(file_path)
        .screenshots({
          count: 1,
          folder: outputDir,
          filename: `${processing_id}_thumbnail.jpg`,
          size: '320x240'
        })
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });
    const thumbnailBuffer = await fs.readFile(thumbnailPath);
    const { publicUrl: thumbnailUrl } = await supabase.storage
      .from('thumbnails')
      .upload(`thumbnails/${processing_id}_thumbnail.jpg`, thumbnailBuffer, { contentType: 'image/jpeg', upsert: true });

    // Send success callback
    await sendCallback(callback_url, {
      processing_id,
      telegram_id,
      chat_id,
      status: 'completed',
      shorts_results: uploadedShorts,
      total_shorts: uploadedShorts.length,
      processing_completed_at: new Date().toISOString(),
      thumbnail_url: thumbnailUrl,
      usage_stats: {
        processing_time: `${Math.floor((Date.now() - data.start_time) / 1000)} seconds`,
        videos_processed: 1,
        shorts_created: uploadedShorts.length,
        quality: subscription_type === 'free' ? '720p' : '1080p',
        storage_method: 'supabase'
      }
    });

    // Cleanup
    await Promise.all([
      ...shortPaths.map(path => fs.unlink(path).catch(() => {})),
      fs.unlink(file_path).catch(() => {}),
      fs.unlink(thumbnailPath).catch(() => {})
    ]);
  } catch (error) {
    console.error(`[${processing_id}] Processing failed:`, error);
    await sendCallback(callback_url, {
      processing_id,
      telegram_id,
      chat_id,
      status: 'error',
      error: { message: error.message, timestamp: new Date().toISOString() }
    });
  }
}

// Get video duration
async function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

// Send callback
async function sendCallback(webhookUrl, data) {
  try {
    await axios.post(webhookUrl, data, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'X-Processing-ID': data.processing_id
      }
    });
    console.log(`[${data.processing_id}] Callback sent successfully`);
  } catch (error) {
    console.error(`[${data.processing_id}] Callback failed:`, error.message);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});