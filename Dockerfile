# Collab Market on Cloud Run: the Node server (index + Gemini agents) and the web app it can also serve.
FROM node:24-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY web /app/web
ENV NODE_ENV=production PORT=8080
CMD ["node", "src/server.ts"]
