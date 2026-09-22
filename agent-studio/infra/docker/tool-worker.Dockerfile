FROM node:22-alpine
WORKDIR /app
COPY . .
RUN pnpm build
CMD ["node", "apps/tool-worker/dist/main.js"]

