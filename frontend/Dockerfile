FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN npm ci --prefer-offline --no-audit --no-fund --silent
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
