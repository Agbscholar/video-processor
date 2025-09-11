const { createClient } = require('@supabase/supabase-js');

class SupabaseStorage {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  // Upload file to temp bucket
  async uploadTempFile(buffer, filename) {
    const { data, error } = await this.supabase.storage
      .from('temp-processing')
      .upload(`temp/${filename}`, buffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (error) throw new Error(`Upload failed: ${error.message}`);
    return data.path;
  }

  // Get signed URL for temp file (private)
  async getTempFileUrl(path, expiresIn = 3600) {
    const { data, error } = await this.supabase.storage
      .from('temp-processing')
      .createSignedUrl(path, expiresIn);

    if (error) throw new Error(`Get URL failed: ${error.message}`);
    return data.signedUrl;
  }

  // Upload processed video to public bucket
  async uploadProcessedVideo(buffer, filename) {
    const { data, error } = await this.supabase.storage
      .from('processed-videos')
      .upload(`processed/${filename}`, buffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (error) throw new Error(`Upload processed failed: ${error.message}`);
    
    // Return public URL
    const publicUrl = this.supabase.storage
      .from('processed-videos')
      .getPublicUrl(data.path);
    
    return {
      path: data.path,
      publicUrl: publicUrl.data.publicUrl
    };
  }

  // Upload thumbnail
  async uploadThumbnail(buffer, filename) {
    const { data, error } = await this.supabase.storage
      .from('video-thumbnails')
      .upload(`thumbs/${filename}`, buffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (error) throw new Error(`Thumbnail upload failed: ${error.message}`);
    
    const publicUrl = this.supabase.storage
      .from('video-thumbnails')
      .getPublicUrl(data.path);
    
    return {
      path: data.path,
      publicUrl: publicUrl.data.publicUrl
    };
  }

  // Clean up temp files
  async cleanupTempFiles(olderThanMinutes = 60) {
    try {
      // List all temp files
      const { data: files, error } = await this.supabase.storage
        .from('temp-processing')
        .list('temp', { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });

      if (error) throw error;

      // Filter files older than specified time
      const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      const oldFiles = files.filter(file => 
        new Date(file.created_at) < cutoffTime
      );

      if (oldFiles.length > 0) {
        const filePaths = oldFiles.map(file => `temp/${file.name}`);
        const { error: deleteError } = await this.supabase.storage
          .from('temp-processing')
          .remove(filePaths);

        if (deleteError) throw deleteError;
        console.log(`Cleaned up ${oldFiles.length} temp files`);
      }
    } catch (error) {
      console.error('Cleanup error:', error.message);
    }
  }

  // Check storage usage
  async getStorageStats() {
    try {
      const buckets = ['temp-processing', 'processed-videos', 'video-thumbnails'];
      const stats = {};
      
      for (const bucket of buckets) {
        const { data: files } = await this.supabase.storage
          .from(bucket)
          .list('', { limit: 1000 });
        
        if (files) {
          const totalSize = files.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
          stats[bucket] = {
            fileCount: files.length,
            totalSizeMB: Math.round(totalSize / (1024 * 1024) * 100) / 100
          };
        }
      }
      
      return stats;
    } catch (error) {
      console.error('Storage stats error:', error.message);
      return {};
    }
  }
}

module.exports = SupabaseStorage;