# Use Node.js 18 with slim Debian base
FROM node:18-slim

# Set environment variables
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies including Python and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp globally
RUN pip3 install --no-cache-dir yt-dlp

# Verify installations
RUN python3 --version && \
    pip3 --version && \
    yt-dlp --version && \
    ffmpeg -version

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /tmp/uploads /tmp/processing /tmp/output && \
    chmod 755 /tmp/uploads /tmp/processing /tmp/output

# Create non-root user for security
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app /tmp/uploads /tmp/processing /tmp/output

# Switch to non-root user
USER appuser

# Expose the port your app runs on
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:10000/health || exit 1

# Start the application
CMD ["npm", "start"]