#!/bin/bash

# Start all development servers for sitegeist and its dependencies
# Usage: ./dev.sh

set -e

echo "Starting development servers..."
echo ""

# Check if required directories exist
if [ ! -d "../pi" ]; then
    echo "Error: pi not found at ../pi"
    exit 1
fi

if [ ! -d "../mini-lit" ]; then
    echo "Error: mini-lit not found at ../mini-lit"
    exit 1
fi

if [ ! -d "../pi-web-ui" ]; then
    echo "Error: pi-web-ui not found at ../pi-web-ui"
    exit 1
fi

# Kill all child processes on exit
trap 'echo ""; echo "Stopping all dev servers..."; kill 0' EXIT INT TERM

# Start dev servers
echo "Starting mini-lit dev server..."
(cd ../mini-lit && npm run dev:tsc) &
MINI_LIT_PID=$!

echo "Starting pi-ai dev server..."
(cd ../pi/packages/ai && npm run dev:tsc) &
PI_AI_PID=$!

echo "Starting pi-agent-core dev server..."
(cd ../pi/packages/agent && npm run dev) &
PI_AGENT_PID=$!

echo "Starting pi-web-ui dev server..."
(cd ../pi-web-ui && npm run dev:tsc) &
PI_WEB_UI_PID=$!

# Wait a moment for dependencies to start building
sleep 2

echo "Starting sitegeist dev server..."
npm run dev &
SITEGEIST_PID=$!

echo "Starting sitegeist site dev server..."
(cd site && ./run.sh dev) &
SITE_PID=$!

echo ""
echo "All dev services started"
echo "  mini-lit: watching"
echo "  pi-ai: watching"
echo "  pi-agent-core: watching"
echo "  pi-web-ui: watching"
echo "  sitegeist: watching"
echo "  site backend: http://localhost:3000"
echo "  site frontend: http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for all background jobs
wait
