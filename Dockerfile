FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js .
# Ops scripts (the Cloudinary mirror, the parity check) need to be runnable with
# `docker exec` against a deployed container. Listed individually so an untracked
# local script — the ones with credentials in them — can never end up in the image.
COPY scripts/mirror-cloudinary.js scripts/check-transform-parity.js ./scripts/
EXPOSE 3000
CMD ["node", "server.js"]
