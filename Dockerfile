FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV LIUKONG_PORT=3000
ENV LIUKONG_HOST=0.0.0.0
ENV LIUKONG_ALLOW_NON_LOOPBACK=true
ENV LIUKONG_DATA_DIR=/data

COPY package.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY README.md ./.env.example ./

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LIUKONG_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
