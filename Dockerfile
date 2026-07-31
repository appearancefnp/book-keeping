# syntax=docker/dockerfile:1

# --- deps: root and web dependency trees, including devDeps (tsx) ---
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

# --- build: compile the Next.js app ---
FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm --prefix web run build

# --- runtime: one image, three entrypoints ---
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
# Overridden by compose for the worker, and by `docker run … npm run migrate`.
CMD ["npm", "--prefix", "web", "run", "start"]
