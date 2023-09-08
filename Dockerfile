# Use the official Node.js 18 base image
FROM node:18

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy the src folder
COPY src ./src

# Copy the package.json and package-lock.json files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Expose the port that the Nest.js application will listen on
EXPOSE 3000

# Start the Nest.js application
CMD [ "sh", "-c", "cd build && node src/index.js" ]
