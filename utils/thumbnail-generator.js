const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;

class ThumbnailGenerator {
  constructor() {
    this.outputDir = '/tmp/thumbnails';
    this.defaultSize = '640x360';
    this.defaultQuality = 2; // JPEG quality (1-31, lower = better)
  }

  async generateThumbnail(videoPath, outputPath, options = {}) {
    const {
      timestamp = '00:00:05', // Default to 5 seconds
      size = this.defaultSize,
      quality = this.defaultQuality,
      format = 'jpg'
    } = options;

    await this.ensureOutputDir();

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .size(size)
        .format('image2')
        .outputOptions([
          `-q:v ${quality}`,
          '-update 1'
        ])
        .on('start', () => {
          console.log(`Generating thumbnail from ${videoPath} at ${timestamp}`);
        })
        .on('end', () => {
          console.log(`Thumbnail generated: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (error) => {
          console.error('Thumbnail generation error:', error);
          reject(new Error(`Thumbnail generation failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async generateMultipleThumbnails(videoPath, processingId, options = {}) {
    const {
      count = 3,
      size = this.defaultSize,
      quality = this.defaultQuality,
      format = 'jpg',
      distribution = 'even' // 'even', 'smart', 'random'
    } = options;

    const metadata = await this.getVideoMetadata(videoPath);
    const timestamps = this.calculateTimestamps(metadata.duration, count, distribution);
    
    const thumbnails = [];

    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const filename = `${processingId}_thumb_${i + 1}.${format}`;
      const outputPath = path.join(this.outputDir, filename);

      try {
        await this.generateThumbnail(videoPath, outputPath, {
          timestamp: this.formatTimestamp(timestamp),
          size,
          quality,
          format
        });

        const stats = await fs.stat(outputPath);

        thumbnails.push({
          index: i + 1,
          path: outputPath,
          filename,
          timestamp: timestamp,
          formattedTimestamp: this.formatTimestamp(timestamp),
          fileSize: stats.size,
          size,
          quality
        });

      } catch (error) {
        console.error(`Failed to generate thumbnail ${i + 1}:`, error);
        // Continue with other thumbnails
      }
    }

    return thumbnails;
  }

  async generateSmartThumbnails(videoPath, processingId, options = {}) {
    const {
      count = 3,
      size = this.defaultSize,
      quality = this.defaultQuality,
      format = 'jpg',
      avoidBlackFrames = true,
      minBrightness = 0.1
    } = options;

    const metadata = await this.getVideoMetadata(videoPath);
    const candidateTimestamps = this.calculateTimestamps(metadata.duration, count * 3, 'even');
    
    const thumbnails = [];
    const usedTimestamps = [];

    for (let i = 0; i < count && candidateTimestamps.length > 0; i++) {
      let bestTimestamp = null;
      let bestScore = -1;

      // Try multiple candidates and pick the best one
      for (let j = 0; j < Math.min(3, candidateTimestamps.length); j++) {
        const timestamp = candidateTimestamps.shift();
        
        try {
          const tempPath = path.join(this.outputDir, `temp_${processingId}_${timestamp}.jpg`);
          await this.generateThumbnail(videoPath, tempPath, {
            timestamp: this.formatTimestamp(timestamp),
            size: '320x180', // Smaller size for analysis
            quality: 5
          });

          const score = avoidBlackFrames ? await this.analyzeThumbnailQuality(tempPath) : 1;
          
          // Clean up temp file
          await fs.unlink(tempPath).catch(() => {});

          if (score > bestScore && score >= minBrightness) {
            bestScore = score;
            bestTimestamp = timestamp;
          }

        } catch (error) {
          console.warn(`Failed to analyze candidate thumbnail at ${timestamp}:`, error);
        }
      }

      if (bestTimestamp !== null) {
        const filename = `${processingId}_smart_thumb_${i + 1}.${format}`;
        const outputPath = path.join(this.outputDir, filename);

        try {
          await this.generateThumbnail(videoPath, outputPath, {
            timestamp: this.formatTimestamp(bestTimestamp),
            size,
            quality,
            format
          });

          const stats = await fs.stat(outputPath);

          thumbnails.push({
            index: i + 1,
            path: outputPath,
            filename,
            timestamp: bestTimestamp,
            formattedTimestamp: this.formatTimestamp(bestTimestamp),
            fileSize: stats.size,
            size,
            quality,
            score: bestScore
          });

          usedTimestamps.push(bestTimestamp);

        } catch (error) {
          console.error(`Failed to generate smart thumbnail ${i + 1}:`, error);
        }
      }
    }

    return thumbnails;
  }

  calculateTimestamps(duration, count, distribution) {
    const timestamps = [];
    
    switch (distribution) {
      case 'even':
        // Distribute evenly, avoiding very beginning and end
        const start = Math.min(10, duration * 0.1);
        const end = duration - Math.min(10, duration * 0.1);
        const usableDuration = end - start;
        
        if (count === 1) {
          timestamps.push(start + usableDuration / 2);
        } else {
          const interval = usableDuration / (count - 1);
          for (let i = 0; i < count; i++) {
            timestamps.push(start + (i * interval));
          }
        }
        break;

      case 'smart':
        // Focus on common "interesting" points
        const interestingPoints = [
          duration * 0.1,  // 10% in
          duration * 0.25, // 25% in
          duration * 0.5,  // Middle
          duration * 0.75, // 75% in
          duration * 0.9   // 90% in
        ];
        
        timestamps.push(...interestingPoints.slice(0, count));
        break;

      case 'random':
        // Random timestamps with some constraints
        const minTime = Math.min(5, duration * 0.05);
        const maxTime = duration - Math.min(5, duration * 0.05);
        
        for (let i = 0; i < count; i++) {
          const randomTime = minTime + Math.random() * (maxTime - minTime);
          timestamps.push(randomTime);
        }
        timestamps.sort((a, b) => a - b);
        break;

      default:
        // Fallback to even distribution
        timestamps.push(...this.calculateTimestamps(duration, count, 'even'));
    }

    return timestamps.map(t => Math.max(0, Math.min(t, duration - 1)));
  }

  formatTimestamp(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
  }

  async analyzeThumbnailQuality(imagePath) {
    // Simple brightness analysis using ImageMagick-style approach
    // This is a simplified version - in production you might use a proper image analysis library
    
    return new Promise((resolve) => {
      ffmpeg(imagePath)
        .complexFilter([
          'signalstats=stat=YAVG'
        ])
        .format('null')
        .on('stderr', (stderrLine) => {
          // Parse brightness from ffmpeg output
          const match = stderrLine.match(/YAVG:(\d+\.?\d*)/);
          if (match) {
            const brightness = parseFloat(match[1]) / 255; // Normalize to 0-1
            resolve(brightness);
            return;
          }
        })
        .on('end', () => {
          resolve(0.5); // Default score if analysis fails
        })
        .on('error', () => {
          resolve(0.5); // Default score if analysis fails
        })
        .output('/dev/null')
        .run();
    });
  }

  async generateAnimatedThumbnail(videoPath, outputPath, options = {}) {
    const {
      startTime = 5,
      duration = 3,
      fps = 10,
      size = '320x180',
      quality = 5
    } = options;

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(startTime)
        .duration(duration)
        .fps(fps)
        .size(size)
        .format('gif')
        .outputOptions([
          `-q:v ${quality}`,
          '-loop 0'
        ])
        .on('start', () => {
          console.log(`Generating animated thumbnail: ${outputPath}`);
        })
        .on('end', () => {
          console.log(`Animated thumbnail generated: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (error) => {
          console.error('Animated thumbnail error:', error);
          reject(new Error(`Animated thumbnail generation failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  async getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }

        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const format = metadata.format;

        resolve({
          duration: parseFloat(format.duration) || 0,
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          fps: this.parseFrameRate(videoStream?.r_frame_rate) || 30
        });
      });
    });
  }

  parseFrameRate(frameRateString) {
    if (!frameRateString) return 30;
    
    try {
      if (frameRateString.includes('/')) {
        const [num, den] = frameRateString.split('/');
        return parseFloat(num) / parseFloat(den);
      }
      return parseFloat(frameRateString);
    } catch {
      return 30;
    }
  }

  async ensureOutputDir() {
    try {
      await fs.mkdir(this.outputDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  async cleanup(processingId) {
    try {
      const files = await fs.readdir(this.outputDir);
      const tempFiles = files.filter(file => 
        file.includes(processingId) || file.startsWith('temp_')
      );

      for (const file of tempFiles) {
        try {
          await fs.unlink(path.join(this.outputDir, file));
        } catch (error) {
          console.error(`Failed to delete thumbnail ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Thumbnail cleanup error:', error);
    }
  }

  // Utility method to convert thumbnail to base64
  async thumbnailToBase64(thumbnailPath) {
    try {
      const buffer = await fs.readFile(thumbnailPath);
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (error) {
      throw new Error(`Failed to convert thumbnail to base64: ${error.message}`);
    }
  }

  // Method to create a contact sheet (grid of thumbnails)
  async createContactSheet(videoPath, outputPath, options = {}) {
    const {
      columns = 4,
      rows = 3,
      thumbnailSize = '160x90',
      spacing = 10,
      backgroundColor = 'black'
    } = options;

    const totalThumbnails = columns * rows;
    const metadata = await this.getVideoMetadata(videoPath);
    const timestamps = this.calculateTimestamps(metadata.duration, totalThumbnails, 'even');

    return new Promise((resolve, reject) => {
      let filterComplex = '';
      let inputs = '';

      // Generate input parameters for each timestamp
      for (let i = 0; i < totalThumbnails; i++) {
        inputs += `-ss ${this.formatTimestamp(timestamps[i])} -i "${videoPath}" `;
      }

      // Build filter complex for grid layout
      for (let i = 0; i < totalThumbnails; i++) {
        filterComplex += `[${i}:v]scale=${thumbnailSize}[thumb${i}];`;
      }

      // Create grid
      let gridFilter = '';
      for (let row = 0; row < rows; row++) {
        let rowInputs = '';
        for (let col = 0; col < columns; col++) {
          const index = row * columns + col;
          rowInputs += `[thumb${index}]`;
        }
        gridFilter += `${rowInputs}hstack=inputs=${columns}[row${row}];`;
      }

      // Stack rows vertically
      let rowInputs = '';
      for (let row = 0; row < rows; row++) {
        rowInputs += `[row${row}]`;
      }
      gridFilter += `${rowInputs}vstack=inputs=${rows}[grid]`;

      filterComplex += gridFilter;

      ffmpeg()
        .input(videoPath)
        .inputOptions(inputs.trim().replace(/-i "[^"]*" $/g, '').split(' '))
        .complexFilter(filterComplex)
        .outputOptions(['-map [grid]', '-frames:v 1'])
        .format('image2')
        .on('start', () => {
          console.log(`Creating contact sheet: ${outputPath}`);
        })
        .on('end', () => {
          console.log(`Contact sheet created: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (error) => {
          console.error('Contact sheet error:', error);
          reject(new Error(`Contact sheet creation failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }
}

module.exports = ThumbnailGenerator;