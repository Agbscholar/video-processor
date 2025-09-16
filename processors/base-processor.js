class BaseProcessor {
  async process(data) {
    const { processing_id, file_path, subscription_type } = data;
    const outputDir = '/tmp/output';
    const shortPaths = [];
    const maxShorts = subscription_type === 'pro' ? 5 : 3;

    try {
      const duration = await this.getVideoDuration(file_path);
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

      return { shorts: shortPaths, total_shorts: shortPaths.length };
    } catch (error) {
      throw new Error(`Processing failed: ${error.message}`);
    }
  }

  async getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.format.duration);
      });
    });
  }
}

module.exports = BaseProcessor;