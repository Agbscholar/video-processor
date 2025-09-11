// processors/main-processor.js - Updated with enhanced error handling
const YouTubeProcessor = require('./youtube-processor');
const WebhookHandler = require('../utils/webhook-handler');

class MainProcessor {
  constructor() {
    this.youtubeProcessor = new YouTubeProcessor();
    this.webhookHandler = new WebhookHandler();
  }

  async processVideo(data) {
    const { 
      processing_id, 
      platform, 
      video_url, 
      callback_url,
      subscription_type = 'free',
      user_limits = {},
      supabase_config
    } = data;

    console.log(`[${processing_id}] Starting video processing`);
    console.log(`[${processing_id}] Platform: ${platform}`);
    console.log(`[${processing_id}] URL: ${video_url}`);
    console.log(`[${processing_id}] Callback: ${callback_url || 'None'}`);

    const startTime = Date.now();
    let result = null;

    try {
      // Validate callback URL if provided
      if (callback_url && !this.webhookHandler.isValidWebhookUrl(callback_url)) {
        throw new Error('Invalid callback URL format');
      }

      // Send progress update if callback URL provided
      if (callback_url) {
        await this.webhookHandler.sendProgress(
          callback_url, 
          'validation', 
          10, 
          processing_id
        ).catch(err => console.warn(`[${processing_id}] Progress callback failed:`, err.message));
      }

      // Route to appropriate processor based on platform
      switch (platform.toLowerCase()) {
        case 'youtube':
          // Send progress update
          if (callback_url) {
            await this.webhookHandler.sendProgress(
              callback_url, 
              'downloading', 
              20, 
              processing_id
            ).catch(err => console.warn(`[${processing_id}] Progress callback failed:`, err.message));
          }

          result = await this.youtubeProcessor.process({
            processing_id,
            video_url,
            video_info: { url: video_url },
            subscription_type,
            user_limits,
            supabase_config
          });
          break;

        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      const processingTime = Math.round((Date.now() - startTime) / 1000);
      
      console.log(`[${processing_id}] Processing completed successfully in ${processingTime}s`);
      console.log(`[${processing_id}] Generated ${result.total_shorts} shorts`);

      // Send success callback
      if (callback_url) {
        const callbackResult = await this.webhookHandler.sendSuccess(
          callback_url, 
          result, 
          processing_id
        );
        
        if (callbackResult.success) {
          console.log(`[${processing_id}] Success callback sent successfully`);
        } else {
          console.error(`[${processing_id}] Success callback failed:`, callbackResult.error);
        }
      }

      return {
        success: true,
        processing_id,
        result,
        processing_time_seconds: processingTime
      };

    } catch (error) {
      const processingTime = Math.round((Date.now() - startTime) / 1000);
      
      console.error(`[${processing_id}] Processing failed after ${processingTime}s:`, error.message);

      // Send failure callback
      if (callback_url) {
        const callbackResult = await this.webhookHandler.sendFailure(
          callback_url, 
          error, 
          processing_id,
          {
            platform,
            video_url,
            processing_time_seconds: processingTime,
            subscription_type
          }
        );
        
        if (callbackResult.success) {
          console.log(`[${processing_id}] Failure callback sent successfully`);
        } else {
          console.error(`[${processing_id}] Failure callback failed:`, callbackResult.error);
        }
      }

      return {
        success: false,
        processing_id,
        error: {
          message: error.message,
          type: this.webhookHandler.classifyError(error),
          processing_time_seconds: processingTime
        }
      };
    }
  }

  // Test webhook endpoint
  async testWebhook(webhookUrl) {
    return await this.webhookHandler.testWebhook(webhookUrl);
  }

  // Get supported platforms
  getSupportedPlatforms() {
    return [
      {
        name: 'YouTube',
        id: 'youtube',
        description: 'Process YouTube videos into short clips',
        supported_formats: ['mp4'],
        max_duration: {
          free: 600, // 10 minutes
          premium: 1800 // 30 minutes
        },
        max_file_size: {
          free: '100MB',
          premium: '500MB'
        }
      }
    ];
  }
}

module.exports = MainProcessor;