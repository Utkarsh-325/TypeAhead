FROM node:22-alpine

# Install build dependencies for sqlite3 if needed, though pre-compiled binaries are usually downloaded
RUN apk add --no-repeat --no-cache make gcc g++ python3

WORKDIR /app

# Copy package configuration
COPY package*.json ./

# Install project dependencies
RUN npm ci

# Copy application files
COPY . .

# Build and populate the SQLite database during image build so it's instantly ready
RUN npm run import

# Expose server port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start Express server
CMD ["npm", "start"]
