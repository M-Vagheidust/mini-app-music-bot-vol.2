FROM node:20-slim
WORKDIR /app
COPY . .
RUN if [ -f package.json ]; then npm install --omit=dev; else cd * && npm install --omit=dev; fi
CMD ["sh", "-c", "if [ -f index.js ]; then node index.js; else cd * && node index.js; fi"]
