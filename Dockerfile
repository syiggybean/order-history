FROM node:20-alpine
RUN apk add --no-cache openssl
# Chromium for purchase order PDFs (puppeteer-core drives it)
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont font-noto
ENV CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
