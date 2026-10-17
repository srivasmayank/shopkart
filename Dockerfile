# Stage 1: Build the application
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# Stage 2: Lightweight production container
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist

# Run as non-root user for security
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

