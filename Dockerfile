# Use Node.js 18 with slim Debian base
FROM node:18-slim

# Set environment variables
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev && npm cache clean --force

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

# Expose the port
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:10000/health || exit 1

# Start the application
CMD ["npm", "start"]