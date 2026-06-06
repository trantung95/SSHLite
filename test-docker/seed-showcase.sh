#!/bin/bash
# seed-showcase.sh — populate a test SSH server with a rich, varied file tree
# so every SSH Lite feature can be screenshotted (browse, filter, search,
# preview, large-file download, terminal, permissions, symlinks, etc).
#
# Usage (inside container, as root):  bash seed-showcase.sh <flavor>
#   <flavor> ∈ prod-web | prod-api | prod-db   (decorates the workspace dir)
#
# Idempotent: wipes the showcase/workspace dirs first, then rebuilds.
set -u

FLAVOR="${1:-dev-box}"
HOME_DIR="/home/testuser"
SC="$HOME_DIR/showcase"
WS="$HOME_DIR/workspace"

echo ">> seeding flavor=$FLAVOR into $HOME_DIR"

rm -rf "$SC" "$WS"
mkdir -p "$SC" "$WS"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
w() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }   # write file w/ content

# ---------------------------------------------------------------------------
# code/ — many languages, nested
# ---------------------------------------------------------------------------
w "$SC/code/frontend/index.html" '<!doctype html><html><head><title>App</title></head><body><h1>Hello</h1></body></html>'
w "$SC/code/frontend/styles.css" 'body { margin: 0; font-family: sans-serif; }
.btn { background: #2563eb; color: #fff; padding: 8px 16px; }'
w "$SC/code/frontend/theme.scss" '$primary: #2563eb;
.card { border: 1px solid $primary; border-radius: 8px; }'
w "$SC/code/frontend/app.tsx" 'import React from "react";
export const App = () => <div>Hello world</div>; // TODO: add routing'
w "$SC/code/frontend/util.ts" 'export function sum(a: number, b: number) { return a + b; }
// FIXME: handle overflow'
w "$SC/code/frontend/legacy.js" 'var x = 1; console.log("legacy script", x);'

w "$SC/code/backend/server.py" '#!/usr/bin/env python3
import sys
def main():
    print("server up")  # TODO: read port from env
if __name__ == "__main__":
    main()'
w "$SC/code/backend/handler.go" 'package main
import "fmt"
func main() { fmt.Println("hello from go") } // FIXME: add error handling'
w "$SC/code/backend/lib.rs" 'pub fn add(a: i32, b: i32) -> i32 { a + b }
// ERROR path not covered'
w "$SC/code/backend/Service.java" 'public class Service {
  public static void main(String[] a){ System.out.println("svc"); }
}'
w "$SC/code/backend/worker.rb" 'puts "worker started" # TODO: queue integration'
w "$SC/code/backend/api.php" '<?php echo "api online"; // FIXME: sanitize input ?>'

w "$SC/code/scripts/deploy.sh" '#!/bin/bash
set -e
echo "deploying..."
echo "done"'
w "$SC/code/scripts/migrate.sql" 'CREATE TABLE users (id INT PRIMARY KEY, name TEXT);
INSERT INTO users VALUES (1, "alice"); -- TODO: add index'
w "$SC/code/scripts/build.ps1" 'Write-Host "Building..."
# ERROR handling needed'
w "$SC/code/scripts/init.lua" 'print("lua init")'
chmod +x "$SC/code/scripts/deploy.sh"

# ---------------------------------------------------------------------------
# config/ — every config flavor
# ---------------------------------------------------------------------------
w "$SC/config/app.json" '{
  "name": "showcase",
  "version": "1.2.3",
  "features": ["search", "terminal", "portForward"]
}'
w "$SC/config/docker-compose.yaml" 'services:
  web:
    image: nginx
    ports: ["80:80"]'
w "$SC/config/settings.yml" 'debug: false
log_level: info
retries: 3'
w "$SC/config/Cargo.toml" '[package]
name = "showcase"
version = "0.1.0"'
w "$SC/config/database.ini" '[db]
host = localhost
port = 5432'
w "$SC/config/nginx.conf" 'server {
  listen 80;
  location / { proxy_pass http://app:3000; }
}'
w "$SC/config/.env" 'NODE_ENV=production
API_KEY=demo-not-a-real-secret
PORT=3000'
w "$SC/config/pom.xml" '<project><groupId>com.demo</groupId><artifactId>app</artifactId></project>'
w "$SC/config/gradle.properties" 'org.gradle.jvmargs=-Xmx2g'

# ---------------------------------------------------------------------------
# docs/ — markdown, text, csv, pdf, rst
# ---------------------------------------------------------------------------
w "$SC/docs/README.md" '# Showcase Project

A demo tree for SSH Lite screenshots.

## Features
- Browse deep folders
- Edit any file type
- Search across servers'
w "$SC/docs/CHANGELOG.md" '## 1.2.3
- Added search
## 1.2.2
- Bug fixes'
w "$SC/docs/notes.txt" 'Plain text note. Remember to rotate keys.'
w "$SC/docs/guide.rst" 'Guide
=====
Section one.'
w "$SC/docs/contacts.csv" 'name,email,role
Alice,alice@demo.io,admin
Bob,bob@demo.io,dev
Carol,carol@demo.io,ops'
# minimal valid PDF so preview works
cat > "$SC/docs/report.pdf" <<'PDF'
%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 100 Td (SSH Lite demo) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
PDF

# ---------------------------------------------------------------------------
# data/ — logs, ndjson, csv, json
# ---------------------------------------------------------------------------
mkdir -p "$SC/data"
{
  echo '[2026-06-01 09:00:01] INFO  app started'
  echo '[2026-06-01 09:00:02] DEBUG cache warmed'
  echo '[2026-06-01 09:01:10] WARN  slow query 1200ms'
  echo '[2026-06-01 09:02:00] ERROR connection refused'
  echo '[2026-06-01 09:02:05] INFO  retrying'
} > "$SC/data/application.log"
{
  echo '{"ts":"2026-06-01T09:00:00Z","level":"info","msg":"boot"}'
  echo '{"ts":"2026-06-01T09:00:05Z","level":"error","msg":"db timeout"}'
} > "$SC/data/events.ndjson"
{
  echo 'date,requests,errors'
  i=1
  while [ "$i" -le 30 ]; do
    echo "2026-05-$(printf '%02d' "$i"),$((i*137)),$((i%5))"
    i=$((i+1))
  done
} > "$SC/data/metrics.csv"
w "$SC/data/users.json" '[{"id":1,"name":"alice"},{"id":2,"name":"bob"}]'

# ---------------------------------------------------------------------------
# images/ — real tiny PNG + GIF + SVG so previews render
# ---------------------------------------------------------------------------
mkdir -p "$SC/images"
# 1x1 transparent PNG
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d > "$SC/images/pixel.png" 2>/dev/null
# 1x1 GIF
printf 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==' | base64 -d > "$SC/images/dot.gif" 2>/dev/null
# small JPEG (reuse png bytes is invalid; make a tiny valid-ish placeholder name)
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d > "$SC/images/logo.png" 2>/dev/null
w "$SC/images/icon.svg" '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#2563eb"/></svg>'
w "$SC/images/diagram.svg" '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#10b981"/><text x="10" y="25" fill="#fff">FLOW</text></svg>'

# ---------------------------------------------------------------------------
# archives/ — tar.gz, gz, zip
# ---------------------------------------------------------------------------
mkdir -p "$SC/archives"
tar -czf "$SC/archives/backup.tar.gz" -C "$SC" docs 2>/dev/null
gzip -c "$SC/data/application.log" > "$SC/archives/application.log.gz" 2>/dev/null
if command -v zip >/dev/null 2>&1; then
  (cd "$SC" && zip -qr "$SC/archives/release.zip" config) 2>/dev/null
else
  # no zip binary: leave a placeholder so the extension still shows a .zip row
  printf 'PK\003\004 placeholder zip' > "$SC/archives/release.zip"
fi

# ---------------------------------------------------------------------------
# deep/ — deeply nested folders (test tree expansion)
# ---------------------------------------------------------------------------
w "$SC/deep/level1/level2/level3/level4/level5/treasure.txt" 'You reached the bottom of the tree.'
mkdir -p "$SC/deep/empty-folder"

# ---------------------------------------------------------------------------
# many-files/ — lots of files for filter + search screenshots
# ---------------------------------------------------------------------------
mkdir -p "$SC/many-files"
i=1
while [ "$i" -le 40 ]; do
  n=$(printf '%03d' "$i")
  case $((i % 5)) in
    0) ext=log;  body="[entry $i] ERROR something failed";;
    1) ext=txt;  body="note number $i — TODO follow up";;
    2) ext=json; body="{\"id\":$i,\"status\":\"ok\"}";;
    3) ext=conf; body="key$i = value$i";;
    *) ext=md;   body="# Document $i";;
  esac
  w "$SC/many-files/file-$n.$ext" "$body"
  i=$((i+1))
done

# ---------------------------------------------------------------------------
# special/ — tricky names + well-known dotless files
# ---------------------------------------------------------------------------
mkdir -p "$SC/special"
w "$SC/special/Dockerfile" 'FROM alpine:3.19
RUN apk add --no-cache bash
CMD ["bash"]'
w "$SC/special/Makefile" 'build:
	@echo building
test:
	@echo testing'
w "$SC/special/LICENSE" 'MIT License — demo only.'
w "$SC/special/.gitignore" 'node_modules/
*.log
.env'
w "$SC/special/.editorconfig" 'root = true
[*]
indent_style = space'
w "$SC/special/file with spaces.txt" 'Filename contains spaces.'
w "$SC/special/résumé-café.md" '# Unicode filename test'
w "$SC/special/UPPER.TXT" 'Uppercase extension.'
w "$SC/special/no-extension" 'A file with no extension at all.'
w "$SC/special/archive.tar.gz.bak" 'double extension backup'

# ---------------------------------------------------------------------------
# binaries/ — non-text content + executable
# ---------------------------------------------------------------------------
mkdir -p "$SC/binaries"
head -c 2048 /dev/urandom > "$SC/binaries/firmware.bin" 2>/dev/null
w "$SC/binaries/run.sh" '#!/bin/bash
echo "running binary tool"'
chmod +x "$SC/binaries/run.sh"
# read-only file (permission screenshot)
w "$SC/binaries/readonly.conf" 'locked = true'
chmod 0444 "$SC/binaries/readonly.conf"

# ---------------------------------------------------------------------------
# large/ — for progressive download / large-file handling
# ---------------------------------------------------------------------------
mkdir -p "$SC/large"
dd if=/dev/zero of="$SC/large/dataset.bin" bs=1M count=30 2>/dev/null
dd if=/dev/urandom of="$SC/large/random-10mb.bin" bs=1M count=10 2>/dev/null

# ---------------------------------------------------------------------------
# links/ — symlinks (file + dir + broken)
# ---------------------------------------------------------------------------
mkdir -p "$SC/links"
ln -sf "$SC/docs/README.md" "$SC/links/readme-link.md"
ln -sf "$SC/code" "$SC/links/code-dir-link"
ln -sf "/nonexistent/target" "$SC/links/broken-link"

# ---------------------------------------------------------------------------
# hidden files/dirs in HOME
# ---------------------------------------------------------------------------
# production-style colored prompt (green user@host, blue cwd) using \h so it
# reflects the real container hostname (hybr8-prod-web-01 / -api-01 / -db-01).
cat > "$HOME_DIR/.bashrc" <<'BRC'
export PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
export LS_OPTIONS='--color=auto'
alias ll='ls -la --color=auto'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'
BRC
w "$HOME_DIR/.gitconfig" '[user]
  name = Demo User
  email = demo@example.com'
mkdir -p "$HOME_DIR/.config/app"
w "$HOME_DIR/.config/app/config.yml" 'theme: dark'
mkdir -p "$HOME_DIR/.cache/tmp"

# ---------------------------------------------------------------------------
# workspace/<flavor> — distinct top-level project per server
# ---------------------------------------------------------------------------
case "$FLAVOR" in
  prod-web)
    P="$WS/web-storefront"
    w "$P/package.json" '{"name":"storefront","version":"3.4.0","scripts":{"start":"node server.js"}}'
    w "$P/server.js" 'require("http").createServer((_,r)=>r.end("OK")).listen(3000);'
    w "$P/public/index.html" '<h1>Storefront</h1>'
    w "$P/public/assets/main.css" 'body{font-family:system-ui}'
    w "$P/src/components/Cart.tsx" 'export const Cart = () => null;'
    w "$P/src/components/Product.tsx" 'export const Product = () => null;'
    w "$P/src/components/Checkout.tsx" 'export const Checkout = () => null;'
    w "$P/deploy/nginx.conf" 'server { listen 80; root /var/www; }'
    w "$P/deploy/Dockerfile" 'FROM node:20-alpine
WORKDIR /app
CMD ["node","server.js"]'
    w "$P/.env.production" 'STRIPE_KEY=demo-not-a-real-secret
CDN_URL=https://cdn.hybr8.io'
    # --- hero set: matches the README overview image (open this folder to shoot it) ---
    w "$P/app.ts" 'import express from "express";
import { Router } from "./routes";

const app = express();
const port = 3000;

// TODO: Add rate limiting
app.use("/api", Router);

app.listen(port, () => {
  console.log(`Server on :${port}`);
});'
    w "$P/src/routes.ts" 'import { Router } from "express";

export const router = Router();
router.get("/health", (_req, res) => res.json({ ok: true }));'
    w "$P/config/config.json" '{
  "port": 3000,
  "db": "postgres://localhost:5432/app",
  "rateLimit": null
}'
    w "$P/config/nginx.conf" 'server {
  listen 80;
  location / { proxy_pass http://localhost:3000; }
}'
    w "$P/Dockerfile" 'FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]'
    w "$P/package.json" '{
  "name": "production-web",
  "version": "3.4.0",
  "scripts": { "start": "node app.js" },
  "dependencies": { "express": "^4.19.0" }
}'
    # pm2 shim so the hero terminal shot (`pm2 status`) matches the mockup. Root-only
    # (writes /usr/local/bin); ignored when the seed runs as a non-root user.
    if [ "$(id -u)" = "0" ]; then
      w "/usr/local/bin/pm2" '#!/bin/sh
printf "%s\n" "┌─────┬──────────────┬─────────┬─────────┬───────┬────────┐"
printf "%s\n" "│ id  │ name         │ mode    │ status  │ cpu   │ mem    │"
printf "%s\n" "├─────┼──────────────┼─────────┼─────────┼───────┼────────┤"
printf "%s\n" "│ 0   │ app-web      │ cluster │ online  │ 12.3% │ 64 MB  │"
printf "%s\n" "│ 1   │ app-worker   │ fork    │ online  │ 5.1%  │ 48 MB  │"
printf "%s\n" "└─────┴──────────────┴─────────┴─────────┴───────┴────────┘"'
      chmod +x /usr/local/bin/pm2
    fi
    ;;
  prod-api)
    P="$WS/payments-api"
    w "$P/main.go" 'package main
func main() {}'
    w "$P/go.mod" 'module payments
go 1.22'
    w "$P/internal/db/schema.sql" 'CREATE TABLE tx(id SERIAL PRIMARY KEY, amount NUMERIC);'
    w "$P/internal/handlers/charge.go" 'package handlers
// FIXME: idempotency keys'
    w "$P/internal/handlers/refund.go" 'package handlers'
    w "$P/k8s/deployment.yaml" 'apiVersion: apps/v1
kind: Deployment
metadata: { name: payments-api }'
    w "$P/k8s/service.yaml" 'apiVersion: v1
kind: Service'
    w "$P/test/load-test.py" 'print("load test")  # TODO: ramp profile'
    ;;
  prod-db|*)
    P="$WS/db-cluster"
    w "$P/postgresql.conf" "max_connections = 200
shared_buffers = 2GB
wal_level = replica"
    w "$P/pg_hba.conf" 'host all all 10.0.0.0/8 md5'
    w "$P/replication.conf" 'primary_conninfo = "host=hybr8-prod-db-01 port=5432"'
    w "$P/schema/users.sql" 'CREATE TABLE users(id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE);'
    w "$P/schema/orders.sql" 'CREATE TABLE orders(id BIGSERIAL PRIMARY KEY, user_id BIGINT);'
    w "$P/scripts/backup.sh" '#!/bin/bash
pg_dump -Fc mydb > /backups/dump-$(date +%F).dump'
    chmod +x "$P/scripts/backup.sh"
    mkdir -p "$P/backups"
    gzip -c "$SC/data/metrics.csv" > "$P/backups/dump-2026-06-01.sql.gz" 2>/dev/null
    gzip -c "$SC/data/users.json" > "$P/backups/dump-2026-06-02.sql.gz" 2>/dev/null
    ;;
esac

# ---------------------------------------------------------------------------
# ownership
# ---------------------------------------------------------------------------
chown -R testuser:testuser "$HOME_DIR"

echo ">> done. summary:"
echo "   files:   $(find "$SC" "$WS" -type f | wc -l)"
echo "   folders: $(find "$SC" "$WS" -type d | wc -l)"
echo "   symlinks:$(find "$SC" "$WS" -type l | wc -l)"
