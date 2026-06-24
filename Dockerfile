FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TENNIS_DB_FILE=/data/tennis.db
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js tennis_ranks.html ./

RUN mkdir -p /data

EXPOSE 3000

CMD ["npm", "start"]
