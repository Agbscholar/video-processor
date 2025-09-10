const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const ytdl = require('ytdl-core');

class VideoDownloader {
  constructor() {
    this.tempDir = '/tmp/downloads';
    this.maxFileSize = 500 * 1024 * 1024; // 500MB
    this.timeout = 300000; // 5 minutes
  }

  async downloadFromUrl(url, processingId, options = {}) {
    const {
      maxSize = this.maxFileSize,
      timeout = this.timeout,
      headers = {}
    } = options;

    // Detect platform and use appropriate downloader
    if (this.isYouTubeUrl(url)) {
      return await this.downloadYouTube(url, processingId);
    } else if (this.isTikTokUrl(url)) {
      return await this.downloadTikTok(url, processingId);
    } else {
      return await this.downloadGeneric(url, processingId, { maxSize, timeout, headers });
    }
  }

  isYouTubeUrl(url) {
    return /(?:youtube\.com|youtu\.be)/.test(url.toLowerCase());
  }

  isTikTokUrl(url) {
    return /tiktok\.com|vm\.tiktok\.com/.test(url.toLowerCase());
  }

  async downloadYouTube(url, processingId) {
    const outputPath = path.join(this.tempDir, `${processingId}_youtube.mp4`);
    
    return new Promise((resolve, reject) => {
      try {
        const stream = ytdl(url, {
          quality: 'highest',
          filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio
        });

        const writeStream = require('fs').createWriteStream(outputPath);
        
        const timeout = setTimeout(() => {
          stream.destroy();
          writeStream.destroy();
          reject(new Error('YouTube download timeout'));
        }, this.timeout);

        stream.on('error', (error) => {
          clearTimeout(timeout);
          writeStream.destroy();
          reject(error);
        });

        writeStream.on('error', (error) => {
          clearTimeout(timeout);
          stream.destroy();
          reject(error);
        });

        writeStream.on('finish', () => {
          clearTimeout(timeout);
          resolve(outputPath);
        });

        stream.pipe(writeStream);

      } catch (error) {
        reject(error);
      }
    });
  }

  async downloadTikTok(url, processingId) {
    // TikTok download would need to be implemented based on your TikTok processor logic
    // This is a placeholder that redirects to generic downloader
    return await this.downloadGeneric(url, processingId);
  }

  async downloadGeneric(url, processingId, options = {}) {
    const { maxSize, timeout, headers } = options;
    const outputPath = path.join(this.tempDir, `${processingId}_generic.mp4`);

    try {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: timeout,
        maxContentLength: maxSize,
        headers: {
          'User-Agent': 'VideoProcessingBot/1.0',
          ...headers
        }
      });

      // Validate content type
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('video/')) {
        throw new Error(`Invalid content type: ${contentType}`);
      }

      // Check file size
      const contentLength = parseInt(response.headers['content-length']);
      if (contentLength && contentLength > maxSize) {
        throw new Error(`File too large: ${Math.round(contentLength / 1024 / 1024)}MB`);
      }

      const writer = require('fs').createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(outputPath));
        writer.on('error', reject);
        response.data.on('error', reject);
      });

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Download timeout');
      } else if (error.response) {
        throw new Error(`Download failed: ${error.response.status} ${error.response.statusText}`);
      } else {
        throw new Error(`Download failed: ${error.message}`);
      }
    }
  }

  async initializeDownloadDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

module.exports = VideoDownloader;