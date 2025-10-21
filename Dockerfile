# Use official Node.js LTS image (latest stable as of 2025)
FROM node:20-slim

# Install system dependencies required by Playwright browsers
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create app directory with non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser
WORKDIR /app

# Copy package files first (layer caching optimization)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Install Playwright Chromium browser
RUN npx playwright install chromium --with-deps

# Copy application source
COPY server.js ./

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user (security best practice)
USER appuser

# Expose HTTP port
EXPOSE 3000

# Health check to ensure service is responsive
# Calls /health endpoint every 30s with 10s timeout
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the server
CMD ["node", "server.js"]

