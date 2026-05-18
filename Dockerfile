FROM node:22-alpine

WORKDIR /app

RUN wget -O /usr/local/bin/hey https://storage.googleapis.com/hey-releases/hey_linux_amd64 && \
    chmod +x /usr/local/bin/hey

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "bench:northflank"]
