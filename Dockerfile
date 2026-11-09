FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8787
# Required for credential vault in production:
#   docker run -e ARBSCOPE_MASTER_KEY=$(openssl rand -hex 32) -p 8787:8787 arbscope
CMD ["node", "server/index.js"]
