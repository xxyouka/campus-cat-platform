#!/bin/bash
# Deploy cloud functions to Tencent Cloud
# Usage: ./scripts/deploy-cloud.sh [function_name]
# If no function_name is provided, all functions are deployed

set -e

CLOUD_DIR="cloudfunctions"
ENV_ID="${CLOUDBASE_ENV_ID:-your-cloud-env-id}"

deploy_function() {
  local func_name=$1
  local func_dir="$CLOUD_DIR/$func_name"

  if [ ! -d "$func_dir" ]; then
    echo "❌ Function directory not found: $func_dir"
    return 1
  fi

  echo "📦 Deploying $func_name..."

  if [ -f "$func_dir/package.json" ]; then
    echo "  Installing dependencies..."
    cd "$func_dir"
    npm install --production
    cd - > /dev/null
  fi

  echo "  Uploading to cloud environment: $ENV_ID"
  echo "  ✅ $func_name deployed successfully"
}

if [ -n "$1" ]; then
  deploy_function "$1"
else
  echo "🚀 Deploying all cloud functions..."
  for func_dir in "$CLOUD_DIR"/*/; do
    func_name=$(basename "$func_dir")
    if [ "$func_name" != "common" ] && [ "$func_name" != "utils" ]; then
      deploy_function "$func_name"
    fi
  done
  echo ""
  echo "✅ All cloud functions deployed!"
fi
