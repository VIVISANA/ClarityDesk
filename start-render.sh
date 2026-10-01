#!/bin/sh
set -eu

PORT="${PORT:-10000}"
sed "s/__PORT__/${PORT}/g" /etc/nginx/conf.d/default.conf > /tmp/claritydesk-nginx.conf
mv /tmp/claritydesk-nginx.conf /etc/nginx/conf.d/default.conf

uvicorn main:app --host 127.0.0.1 --port 8000 &
exec nginx -g "daemon off;"
