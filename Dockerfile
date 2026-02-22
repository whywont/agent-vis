FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev=false

COPY . .
RUN npm run build

EXPOSE 3333
ENV NODE_ENV=production

CMD ["node", "server.js"]
