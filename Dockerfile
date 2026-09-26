# Use a Python 3.10 slim image
FROM python:3.10-slim

# Install Node.js (for Hardhat) and curl
RUN apt-get update && apt-get install -y curl
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
RUN apt-get install -y nodejs

# Set working directory
WORKDIR /app

# Copy the whole project
COPY . /app

# Install Python dependencies
RUN pip install --no-cache-dir -r backend/requirements.txt

# Install Hardhat dependencies
WORKDIR /app/backend/blockchain/hardhat-env
RUN npm install

# Set working directory back to /app
WORKDIR /app

# Expose port (Render sets PORT env variable)
EXPOSE 8000
EXPOSE 8545

# Make the start script executable
RUN chmod +x render-start.sh

# Start the application
CMD ["./render-start.sh"]
