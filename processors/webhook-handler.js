// utils/webhook-handler.js - Enhanced webhook callback with retry logic
const axios = require('axios');

class WebhookHandler {
  constructor() {
    this.maxRetries = 5;
    this.retryDelays = [1000, 2000, 5000, 10000, 30000]; // Progressive delays in ms
    this.timeout = 15000; // 15 seconds timeout
  }

  async sendCallback(webhookUrl, data, processingId) {
    if (!webhookUrl || !webhookUrl.startsWith('http')) {
      console.warn(`[${processingId}] Invalid webhook URL provided: ${webhookUrl}`);
      return { success: false, error: 'Invalid webhook URL' };
    }

    console.log(`[${processingId}] Preparing webhook callback to: ${webhookUrl}`);
    
    // Prepare callback payload
    const payload = {
      processing_id: processingId,
      timestamp: new Date().toISOString(),
      status: data.error ? 'failed' : 'completed',
      ...data
    };

    let lastError = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`[${processingId}] Sending callback attempt ${attempt}/${this.maxRetries}`);
        
        const response = await axios.post(webhookUrl, payload, {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'VideoProcessingService/1.0',
            'X-Processing-ID': processingId,
            'X-Callback-Attempt': attempt.toString(),
            'X-Service-Version': '1.0.0'
          },
          // Validate status codes (don't throw on 4xx/5xx)
          validateStatus: (status) => status >= 200 && status < 600
        });

        // Check response status
        if (response.status >= 200 && response.status < 300) {
          console.log(`[${processingId}] Callback sent successfully, status: ${response.status}`);
          return {
            success: true,
            status: response.status,
            data: response.data,
            attempt: attempt
          };
        } else if (response.status === 404) {
          console.error(`[${processingId}] Webhook endpoint not found (404). URL may be incorrect: ${webhookUrl}`);
          return {
            success: false,
            status: response.status,
            error: 'Webhook endpoint not found (404)',
            final: true // Don't retry 404s
          };
        } else if (response.status >= 400 && response.status < 500) {
          // Client errors - usually don't retry except for specific cases
          console.error(`[${processingId}] Client error ${response.status}: ${response.statusText}`);
          
          if (response.status === 429) { // Rate limited - retry with longer delay
            lastError = new Error(`Rate limited (429). Response: ${JSON.stringify(response.data)}`);
            await this.sleep(this.retryDelays[Math.min(attempt, this.retryDelays.length - 1)] * 2);
            continue;
          }
          
          return {
            success: false,
            status: response.status,
            error: `Client error: ${response.statusText}`,
            data: response.data,
            final: response.status !== 408 // Retry timeouts, but not other 4xx
          };
        } else {
          // Server errors - retry
          lastError = new Error(`Server error ${response.status}: ${response.statusText}`);
          console.warn(`[${processingId}] Server error ${response.status}, will retry`);
        }

      } catch (error) {
        lastError = error;
        
        if (error.code === 'ECONNREFUSED') {
          console.error(`[${processingId}] Connection refused to webhook URL: ${webhookUrl}`);
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          console.error(`[${processingId}] Timeout connecting to webhook: ${error.message}`);
        } else if (error.code === 'ENOTFOUND') {
          console.error(`[${processingId}] Webhook host not found: ${webhookUrl}`);
          return {
            success: false,
            error: 'Webhook host not found',
            final: true // Don't retry DNS errors
          };
        } else {
          console.error(`[${processingId}] Webhook error attempt ${attempt}:`, error.message);
        }
      }

      // Wait before retry (except on last attempt)
      if (attempt < this.maxRetries) {
        const delay = this.retryDelays[Math.min(attempt - 1, this.retryDelays.length - 1)];
        console.log(`[${processingId}] Waiting ${delay}ms before retry ${attempt + 1}`);
        await this.sleep(delay);
      }
    }

    // All retries failed
    console.error(`[${processingId}] All webhook callback attempts failed. Last error:`, lastError?.message);
    
    return {
      success: false,
      error: lastError?.message || 'All callback attempts failed',
      attempts: this.maxRetries,
      final: true
    };
  }

  // Send success callback
  async sendSuccess(webhookUrl, result, processingId) {
    const data = {
      status: 'completed',
      result: result,
      message: 'Video processing completed successfully',
      shorts_count: result.total_shorts || 0,
      platform: result.platform || 'YouTube',
      processing_time: result.usage_stats?.processing_time || 'unknown'
    };

    return await this.sendCallback(webhookUrl, data, processingId);
  }

  // Send failure callback
  async sendFailure(webhookUrl, error, processingId, context = {}) {
    const data = {
      status: 'failed',
      error: {
        message: error.message,
        type: this.classifyError(error),
        code: error.code || 'PROCESSING_ERROR'
      },
      context: context,
      message: 'Video processing failed'
    };

    return await this.sendCallback(webhookUrl, data, processingId);
  }

  // Send progress update (optional)
  async sendProgress(webhookUrl, stage, progress, processingId) {
    const data = {
      status: 'processing',
      stage: stage,
      progress: progress,
      message: `Processing: ${stage}`,
      timestamp: new Date().toISOString()
    };

    // Use fewer retries for progress updates
    const originalMaxRetries = this.maxRetries;
    this.maxRetries = 2;
    
    const result = await this.sendCallback(webhookUrl, data, processingId);
    
    this.maxRetries = originalMaxRetries;
    return result;
  }

  // Classify error types for better client handling
  classifyError(error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('bot') || message.includes('sign in')) {
      return 'BOT_DETECTION';
    } else if (message.includes('private') || message.includes('unavailable')) {
      return 'VIDEO_UNAVAILABLE';
    } else if (message.includes('age-restricted')) {
      return 'AGE_RESTRICTED';
    } else if (message.includes('region') || message.includes('blocked')) {
      return 'REGION_BLOCKED';
    } else if (message.includes('too long') || message.includes('duration')) {
      return 'VIDEO_TOO_LONG';
    } else if (message.includes('too large') || message.includes('file size')) {
      return 'FILE_TOO_LARGE';
    } else if (message.includes('timeout') || message.includes('network')) {
      return 'NETWORK_ERROR';
    } else if (message.includes('invalid data') || message.includes('corrupted')) {
      return 'CORRUPTED_VIDEO';
    } else if (message.includes('ffmpeg') || message.includes('encoding')) {
      return 'ENCODING_ERROR';
    } else if (message.includes('storage') || message.includes('upload')) {
      return 'STORAGE_ERROR';
    } else {
      return 'UNKNOWN_ERROR';
    }
  }

  // Validate webhook URL format
  isValidWebhookUrl(url) {
    try {
      const parsedUrl = new URL(url);
      return ['http:', 'https:'].includes(parsedUrl.protocol);
    } catch {
      return false;
    }
  }

  // Test webhook connectivity
  async testWebhook(webhookUrl, processingId = 'test') {
    if (!this.isValidWebhookUrl(webhookUrl)) {
      return { success: false, error: 'Invalid webhook URL format' };
    }

    const testPayload = {
      processing_id: processingId,
      status: 'test',
      message: 'Webhook connectivity test',
      timestamp: new Date().toISOString(),
      service: 'VideoProcessingService',
      version: '1.0.0'
    };

    try {
      const response = await axios.post(webhookUrl, testPayload, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'VideoProcessingService/1.0',
          'X-Test-Request': 'true'
        },
        validateStatus: (status) => status >= 200 && status < 600
      });

      return {
        success: response.status >= 200 && response.status < 300,
        status: response.status,
        data: response.data,
        message: response.status >= 200 && response.status < 300 ? 
          'Webhook test successful' : 
          `Webhook returned status ${response.status}`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WebhookHandler;