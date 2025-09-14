# Use Node.js 18 with slim Debian base
FROM node:18-slim

# Set environment variables
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/render/project/bin:$PATH"

# Install system dependencies including Python and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    ffmpeg \
    curl \
    wget \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create a Python virtual environment
RUN python3 -m venv /opt/venv

# Activate virtual environment and install yt-dlp
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir yt-dlp

# Create bin directory and symlink yt-dlp for multiple access methods
RUN mkdir -p /opt/render/project/bin /usr/local/bin
RUN ln -sf /opt/venv/bin/yt-dlp /opt/render/project/bin/yt-dlp
RUN ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp
RUN ln -sf /opt/venv/bin/yt-dlp /usr/bin/yt-dlp

# Verify installations
RUN python3 --version
RUN pip --version
RUN yt-dlp --version
RUN ffmpeg -version

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

# Create non-root user for security but ensure they can access yt-dlp
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app /tmp/uploads /tmp/processing /tmp/output

# Ensure appuser can access the virtual environment
RUN chown -R appuser:appuser /opt/venv
RUN chmod +x /opt/venv/bin/yt-dlp

# Switch to non-root user
USER appuser

# Ensure PATH includes venv for the appuser
ENV PATH="/opt/venv/bin:$PATH"

# Expose the port your app runs on
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:10000/health || exit 1

# Start the application
CMD ["npm", "start"]