FROM node:18-alpine3.17

WORKDIR /usr/src/app
COPY package*.json ./
COPY tsconfig.json ./
COPY tslint.json ./
COPY yarn.lock ./

COPY src ./src
COPY types ./types
COPY abi ./abi

RUN npm ci
RUN npm run build
RUN npm start
