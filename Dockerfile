# The API as one container (HANDOVER §16 #1 recommends a container first).
#   docker build -t stitchflow-api .
#   docker run --env-file .env -p 3000:3000 stitchflow-api
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY contract/package.json contract/
COPY api/package.json api/
COPY db/check/package.json db/check/
RUN npm ci --omit=dev --workspace api --include-workspace-root=false && npm cache clean --force
COPY contract contract
COPY db/migrations db/migrations
COPY db/views db/views
COPY api/src api/src
USER node
EXPOSE 3000
WORKDIR /app/api
CMD ["node", "src/server.ts"]
