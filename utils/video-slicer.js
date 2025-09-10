const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;

class VideoSlicer {
  constructor() {
    this.outputDir = '/tmp/sliced';
  }

  async sliceVideo(inputPath, segments, processingId, options = {}) {
    const {
      quality = '720p',
      format = 'mp4',
      watermark = null,
      targetAspectRatio = '16:9'
    } = options;

    await this.ensureOutputDir();

    const slicedVideos = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const outputPath = path.join(
        this.outputDir,
        `${processingId}_slice_${i + 1}.${format}`
      );

      try {
        await this.extractSegment(inputPath, outputPath, segment, {
          quality,
          format,
          watermark,
          targetAspectRatio
        });

        const stats = await fs.stat(outputPath);

        slicedVideos.push({
          index: i + 1,
          path: outputPath,
          startTime: segment.start,
          duration: segment.duration,
          endTime: segment.start + segment.duration,
          fileSize: stats.size,
          fileSizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
          quality,
          format
        });

      } catch (error) {
        console.error(`Failed to slice segment ${i + 1}:`, error);
        // Continue with other segments
      }
    }

    return slicedVideos;
  }

  async extractSegment(inputPath, outputPath, segment, options) {
    const { quality, format, watermark, targetAspectRatio } = options;
    
    return new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath)
        .seekInput(segment.start)
        .duration(segment.duration)
        .videoCodec('libx264')
        .audioCodec('aac')
        .format(format);

      // Set quality parameters
      const qualitySettings = this.getQualitySettings(quality);
      command = command
        .size(qualitySettings.resolution)
        .videoBitrate(qualitySettings.videoBitrate)
        .audioBitrate(qualitySettings.audioBitrate);

      // Add standard options
      command = command.outputOptions([
        '-preset fast',
        '-crf 23',
        '-movflags +faststart',
        '-pix_fmt yuv420p'
      ]);

      // Handle aspect ratio if needed
      if (targetAspectRatio && targetAspectRatio !== '16:9') {
        const aspectRatioFilter = this.getAspectRatioFilter(targetAspectRatio, qualitySettings.resolution);
        command = command.outputOptions([`-vf ${aspectRatioFilter}`]);
      }

      // Add watermark if specified
      if (watermark) {
        const watermarkFilter = this.getWatermarkFilter(watermark);
        const existingFilters = command._outputs[0].options.find(opt => opt.startsWith('-vf'));
        
        if (existingFilters) {
          // Combine with existing filters
          const filterIndex = command._outputs[0].options.indexOf(existingFilters);
          command._outputs[0].options[filterIndex] = `${existingFilters},${watermarkFilter}`;
        } else {
          command = command.outputOptions([`-vf ${watermarkFilter}`]);
        }
      }

      command
        .on('start', (cmd) => {
          console.log(`Slicing segment: ${segment.start}s-${segment.start + segment.duration}s`);
        })
        .on('progress', (progress) => {
          if (progress.percent && progress.percent % 25 === 0) {
            console.log(`Slicing progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`Segment sliced successfully: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          console.error(`Slicing error:`, error);
          reject(new Error(`Video slicing failed: ${error.message}`));
        })
        .save(outputPath);
    });
  }

  getQualitySettings(quality) {
    const settings = {
      '480p': {
        resolution: '854x480',
        videoBitrate: '1500k',
        audioBitrate: '128k'
      },
      '720p': {
        resolution: '1280x720',
        videoBitrate: '2500k',
        audioBitrate: '128k'
      },
      '1080p': {
        resolution: '1920x1080',
        videoBitrate: '5000k',
        audioBitrate: '192k'
      }
    };

    return settings[quality] || settings['720p'];
  }

  getAspectRatioFilter(targetRatio, resolution) {
    // Convert aspect ratio to filter format
    switch (targetRatio) {
      case '9:16': // Vertical (TikTok/Instagram Stories)
        return `scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black`;
      case '1:1': // Square (Instagram)
        return `scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black`;
      case '16:9': // Landscape (YouTube)
      default:
        return `scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2:black`;
    }
  }

  getWatermarkFilter(watermarkText) {
    return `drawtext=text='${watermarkText}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:x=10:y=H-th-10`;
  }

  async createSmartSegments(videoDuration, options = {}) {
    const {
      segmentDuration = 60, // Default 60 seconds
      maxSegments = 5,
      skipStart = 10, // Skip first 10 seconds
      skipEnd = 10,   // Skip last 10 seconds
      minSegmentDuration = 30
    } = options;

    const usableStart = Math.min(skipStart, videoDuration * 0.1);
    const usableEnd = videoDuration - Math.min(skipEnd, videoDuration * 0.1);
    const usableDuration = usableEnd - usableStart;

    if (usableDuration < minSegmentDuration) {
      throw new Error('Video too short for smart segmentation');
    }

    const segments = [];
    const possibleSegments = Math.floor(usableDuration / segmentDuration);
    const numSegments = Math.min(maxSegments, possibleSegments);

    if (numSegments === 1) {
      // Single segment from the middle of the video
      const start = usableStart + (usableDuration - segmentDuration) / 2;
      segments.push({
        start: Math.max(0, start),
        duration: Math.min(segmentDuration, usableDuration)
      });
    } else {
      // Multiple segments evenly distributed
      const interval = usableDuration / numSegments;
      
      for (let i = 0; i < numSegments; i++) {
        const start = usableStart + (i * interval);
        const remainingDuration = usableEnd - start;
        const duration = Math.min(segmentDuration, remainingDuration);
        
        if (duration >= minSegmentDuration) {
          segments.push({
            start: Math.floor(start),
            duration: Math.floor(duration)
          });
        }
      }
    }

    return segments;
  }

  async detectVideoHighlights(inputPath, options = {}) {
    // This is a simplified highlight detection
    // In a production environment, you might use more sophisticated analysis
    const {
      segmentDuration = 60,
      maxSegments = 3,
      analysisMethod = 'scene_change' // 'scene_change', 'audio_peak', 'motion'
    } = options;

    // For now, return evenly spaced segments
    // This could be enhanced with actual video analysis
    const metadata = await this.getVideoMetadata(inputPath);
    
    return await this.createSmartSegments(metadata.duration, {
      segmentDuration,
      maxSegments,
      skipStart: metadata.duration * 0.05, // Skip first 5%
      skipEnd: metadata.duration * 0.05     // Skip last 5%
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
          fps: this.parseFrameRate(videoStream?.r_frame_rate) || 30,
          bitrate: parseInt(format.bit_rate) || 0,
          size: parseInt(format.size) || 0
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
      const tempFiles = files.filter(file => file.includes(processingId));

      for (const file of tempFiles) {
        try {
          await fs.unlink(path.join(this.outputDir, file));
        } catch (error) {
          console.error(`Failed to delete ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
}

module.exports = VideoSlicer;