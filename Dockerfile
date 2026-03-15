FROM node:20-slim

WORKDIR /app

# better-sqlite3 빌드에 필요한 패키지
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

# uploads 디렉토리 생성
RUN mkdir -p uploads/applications uploads/ads uploads/profiles

EXPOSE 3000

CMD ["node", "index.js"]
