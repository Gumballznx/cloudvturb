FROM node:20-alpine

RUN apk add --no-cache python3 build-base ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY *.js ./
COPY public ./public

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV VIDEOS_DIR=/app/videos
ENV PUBLIC_DIR=/app/public

CMD ["node", "server.js"]
