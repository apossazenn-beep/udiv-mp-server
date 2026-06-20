# Minimal image for the multiplayer RELAY only (server.js + ws).
# The relay forwards JSON between players by room code; it does NOT need
# game.html, assets, Electron or anything else — so the image stays tiny.
FROM node:20-alpine
WORKDIR /app
# Install just the WebSocket lib (no package.json deps → no Electron on the server).
RUN npm install ws@^8.20.1 --no-audit --no-fund
COPY server.js ./
# Cloud hosts inject PORT; default to 8080 locally. server.js binds 0.0.0.0 in cloud.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
