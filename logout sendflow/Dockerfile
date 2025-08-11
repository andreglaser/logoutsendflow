# Base oficial do Playwright com Chromium + deps
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["npm", "start"]
