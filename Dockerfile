# DockPilot - Production Dockerfile
# Optimized for high-density Docker management

FROM node:18-alpine

# Use production environment
ENV NODE_ENV=production

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm install --production && \
    npm cache clean --force

# Copy application source (filtered by .dockerignore)
COPY . .

# Ensure the app can write to its directory (for users.json)
RUN chmod 777 /usr/src/app

# Bind to port 3000
EXPOSE 3000

# Default environment variables
ENV JWT_SECRET=dockpilot-default-secret-789
ENV PORT=3000

# Start the Enterprise engine
CMD ["node", "server.js"]
