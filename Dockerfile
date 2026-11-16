FROM node:22-slim
WORKDIR /app
COPY . .
RUN if [ -f package.json ]; then npm install --omit=dev; else cd * && npm install --omit=dev; fi
CMD ["sh", "-c", "if [ -f index.js ]; then node --no-warnings index.js; else cd * && node --no-warnings index.js; fi"]
