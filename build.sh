#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Building admin frontend..."
cd "$ROOT_DIR/AAAADMIN"
npm run build

echo "==> Building Go server..."
cd "$ROOT_DIR/AAAAPI"
go build -o aaaapi .

echo "==> Build complete!"
echo "    Run: cd AAAAPI && ./aaaapi"
echo "    Admin: http://localhost:3000"
echo "    API:   http://localhost:3000/api/v1/health"
