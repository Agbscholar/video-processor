const { createClient } = require('@supabase/supabase-js');

class SupabaseClient {
  constructor(url, serviceKey) {
    if (!url || !serviceKey) {
      throw new Error('Supabase URL and service key are required');
    }
    
    this.client = createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    this.url = url;
    this.serviceKey = serviceKey;
  }

  // Video processing records
  async saveProcessingRecord(data) {
    const {
      processing_id,
      original_url,
      platform,
      title,
      subscription_type,
      metadata,
      shorts_count,
      telegram_id,
      chat_id,
      status = 'processing'
    } = data;

    try {
      const { data: result, error } = await this.client
        .from('video_processing')
        .upsert({
          processing_id,
          original_url,
          platform,
          title: title?.substring(0, 500) || 'Untitled Video',
          status,
          subscription_type,
          telegram_id,
          chat_id,
          metadata: {
            duration: metadata?.duration || 0,
            size_mb: metadata?.size_mb || 0,
            resolution: metadata?.width && metadata?.height ? 
              `${metadata.width}x${metadata.height}` : 'Unknown',
            fps: metadata?.fps || 30,
            codec: metadata?.codec || 'Unknown',
            format: metadata?.format || 'Unknown',
            has_audio: metadata?.has_audio || false
          },
          shorts_count: shorts_count || 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (error) {
        console.error('Error saving processing record:', error);
        throw error;
      }

      return result;
    } catch (error) {
      console.error('Failed to save processing record:', error);
      throw error;
    }
  }

  async updateProcessingStatus(processing_id, status, additionalData = {}) {
    try {
      const updateData = {
        status,
        updated_at: new Date().toISOString(),
        ...additionalData
      };

      const { error } = await this.client
        .from('video_processing')
        .update(updateData)
        .eq('processing_id', processing_id);

      if (error) {
        console.error('Error updating processing status:', error);
        throw error;
      }

      return true;
    } catch (error) {
      console.error('Failed to update processing status:', error);
      throw error;
    }
  }

  // Short videos management
  async saveShortVideo(data) {
    const {
      short_id,
      processing_id,
      title,
      file_url,
      thumbnail_url,
      storage_path,
      thumbnail_storage_path,
      duration,
      file_size_mb,
      quality,
      segment_index,
      start_time,
      has_watermark,
      metadata = {}
    } = data;

    try {
      const { data: result, error } = await this.client
        .from('short_videos')
        .insert({
          short_id,
          processing_id,
          title: title?.substring(0, 200) || 'Short Video',
          file_url,
          thumbnail_url,
          storage_path,
          thumbnail_storage_path,
          duration: duration || 60,
          file_size_mb: file_size_mb || 0,
          quality: quality || '720p',
          segment_index: segment_index || 1,
          start_time: start_time || 0,
          has_watermark: has_watermark || false,
          metadata,
          created_at: new Date().toISOString()
        });

      if (error) {
        console.error('Error saving short video:', error);
        throw error;
      }

      return result;
    } catch (error) {
      console.error('Failed to save short video:', error);
      throw error;
    }
  }

  async saveMultipleShorts(shorts, processing_id) {
    const shortRecords = shorts.map(short => ({
      short_id: short.short_id,
      processing_id: processing_id,
      title: short.title?.substring(0, 200) || 'Short Video',
      file_url: short.file_url,
      thumbnail_url: short.thumbnail_url,
      storage_path: short.storage_path,
      thumbnail_storage_path: short.thumbnail_storage_path,
      duration: short.duration || 60,
      file_size_mb: short.file_size_mb || 0,
      quality: short.quality || '720p',
      segment_index: short.segment_index || 1,
      start_time: short.start_time || 0,
      has_watermark: short.has_watermark || false,
      metadata: short.metadata || {},
      created_at: new Date().toISOString()
    }));

    try {
      const { data: result, error } = await this.client
        .from('short_videos')
        .insert(shortRecords);

      if (error) {
        console.error('Error saving multiple shorts:', error);
        throw error;
      }

      return result;
    } catch (error) {
      console.error('Failed to save multiple shorts:', error);
      throw error;
    }
  }

  // Storage operations
  async uploadFile(bucket, path, fileBuffer, options = {}) {
    const {
      contentType = 'application/octet-stream',
      cacheControl = '3600',
      upsert = false
    } = options;

    try {
      const { error } = await this.client.storage
        .from(bucket)
        .upload(path, fileBuffer, {
          contentType,
          cacheControl,
          upsert
        });

      if (error) {
        console.error(`Error uploading to ${bucket}/${path}:`, error);
        throw error;
      }

      // Get public URL
      const { data: { publicUrl } } = this.client.storage
        .from(bucket)
        .getPublicUrl(path);

      return {
        success: true,
        path,
        publicUrl,
        bucket
      };
    } catch (error) {
      console.error('File upload failed:', error);
      throw error;
    }
  }

  async uploadVideo(processingId, shortId, videoBuffer) {
    const path = `shorts/${processingId}/${shortId}.mp4`;
    return await this.uploadFile('processed-shorts', path, videoBuffer, {
      contentType: 'video/mp4',
      cacheControl: '3600',
      upsert: false
    });
  }

  async uploadThumbnail(processingId, shortId, thumbnailBuffer) {
    const path = `thumbnails/${processingId}/${shortId}.jpg`;
    return await this.uploadFile('thumbnails', path, thumbnailBuffer, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: false
    });
  }

  async deleteFile(bucket, path) {
    try {
      const { error } = await this.client.storage
        .from(bucket)
        .remove([path]);

      if (error) {
        console.error(`Error deleting ${bucket}/${path}:`, error);
        throw error;
      }

      return true;
    } catch (error) {
      console.error('File deletion failed:', error);
      throw error;
    }
  }

  // User management and limits
  async getUserLimits(telegram_id) {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('subscription_type, usage_limits, current_usage')
        .eq('telegram_id', telegram_id)
        .single();

      if (error && error.code !== 'PGRST116') { // Not found error
        console.error('Error fetching user limits:', error);
        throw error;
      }

      if (!data) {
        // Return default free user limits
        return {
          subscription_type: 'free',
          usage_limits: {
            max_shorts: 3,
            max_video_duration: 600, // 10 minutes
            max_file_size_mb: 100,
            monthly_processing: 10
          },
          current_usage: {
            monthly_processed: 0,
            total_shorts_created: 0
          }
        };
      }

      return data;
    } catch (error) {
      console.error('Failed to get user limits:', error);
      throw error;
    }
  }

  async updateUserUsage(telegram_id, usageData) {
    const {
      shorts_created = 0,
      processing_time = 0,
      storage_used_mb = 0
    } = usageData;

    try {
      // Get current usage
      const { data: currentData, error: fetchError } = await this.client
        .from('users')
        .select('current_usage')
        .eq('telegram_id', telegram_id)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      const currentUsage = currentData?.current_usage || {
        monthly_processed: 0,
        total_shorts_created: 0,
        total_processing_time: 0,
        storage_used_mb: 0
      };

      // Update usage
      const updatedUsage = {
        monthly_processed: currentUsage.monthly_processed + 1,
        total_shorts_created: currentUsage.total_shorts_created + shorts_created,
        total_processing_time: currentUsage.total_processing_time + processing_time,
        storage_used_mb: currentUsage.storage_used_mb + storage_used_mb,
        last_processed: new Date().toISOString()
      };

      const { error: updateError } = await this.client
        .from('users')
        .upsert({
          telegram_id,
          current_usage: updatedUsage,
          updated_at: new Date().toISOString()
        });

      if (updateError) {
        throw updateError;
      }

      return updatedUsage;
    } catch (error) {
      console.error('Failed to update user usage:', error);
      throw error;
    }
  }

  // Analytics and reporting
  async getProcessingStats(processing_id) {
    try {
      const { data: processing, error: processError } = await this.client
        .from('video_processing')
        .select('*')
        .eq('processing_id', processing_id)
        .single();

      if (processError) {
        throw processError;
      }

      const { data: shorts, error: shortsError } = await this.client
        .from('short_videos')
        .select('*')
        .eq('processing_id', processing_id);

      if (shortsError) {
        throw shortsError;
      }

      return {
        processing,
        shorts,
        summary: {
          total_shorts: shorts.length,
          total_duration: shorts.reduce((sum, short) => sum + (short.duration || 0), 0),
          total_size_mb: shorts.reduce((sum, short) => sum + (short.file_size_mb || 0), 0),
          average_quality: shorts.length > 0 ? 
            shorts.filter(s => s.quality === '1080p').length / shorts.length : 0
        }
      };
    } catch (error) {
      console.error('Failed to get processing stats:', error);
      throw error;
    }
  }

  async getRecentProcessing(telegram_id, limit = 10) {
    try {
      const { data, error } = await this.client
        .from('video_processing')
        .select(`
          processing_id,
          title,
          platform,
          status,
          shorts_count,
          created_at,
          short_videos (
            short_id,
            file_url,
            thumbnail_url,
            duration,
            quality
          )
        `)
        .eq('telegram_id', telegram_id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Failed to get recent processing:', error);
      throw error;
    }
  }

  // Cleanup operations
  async cleanupOldProcessing(days = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    try {
      // Get old processing records
      const { data: oldRecords, error: fetchError } = await this.client
        .from('video_processing')
        .select('processing_id')
        .lt('created_at', cutoffDate.toISOString());

      if (fetchError) {
        throw fetchError;
      }

      if (oldRecords.length === 0) {
        return { cleaned: 0, message: 'No old records to clean' };
      }

      const processingIds = oldRecords.map(r => r.processing_id);

      // Delete associated short videos first
      const { error: shortsDeleteError } = await this.client
        .from('short_videos')
        .delete()
        .in('processing_id', processingIds);

      if (shortsDeleteError) {
        throw shortsDeleteError;
      }

      // Delete processing records
      const { error: processDeleteError } = await this.client
        .from('video_processing')
        .delete()
        .in('processing_id', processingIds);

      if (processDeleteError) {
        throw processDeleteError;
      }

      return {
        cleaned: oldRecords.length,
        message: `Cleaned up ${oldRecords.length} old processing records`
      };
    } catch (error) {
      console.error('Cleanup failed:', error);
      throw error;
    }
  }

  // Health check
  async healthCheck() {
    try {
      const { data, error } = await this.client
        .from('video_processing')
        .select('count')
        .limit(1);

      if (error) {
        throw error;
      }

      return {
        status: 'healthy',
        connection: 'active',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        connection: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Utility method to create a new client instance
  static createInstance(config) {
    const { url, service_key } = config;
    return new SupabaseClient(url, service_key);
  }
}

module.exports = SupabaseClient;