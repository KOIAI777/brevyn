#!/usr/bin/env bash

set -euo pipefail

required_variables=(
  GH_TOKEN
  RELEASE_REPOSITORY
  RELEASE_TAG
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_ENDPOINT
  R2_BUCKET
  R2_EDITION
  R2_PUBLIC_BASE_URL
)

for variable in "${required_variables[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    echo "::error::Missing required environment variable: ${variable}"
    exit 1
  fi
done

for command in gh aws python3 curl sha256sum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "::error::Required command is not available: ${command}"
    exit 1
  fi
done

if [[ "$RELEASE_TAG" == *-* ]]; then
  channel="prerelease"
else
  channel="stable"
fi

destination_prefix="${R2_EDITION}/${channel}"
work_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/brevyn-r2-${R2_EDITION}-${RELEASE_TAG}"
asset_dir="${work_root}/assets"

rm -rf "$work_root"
mkdir -p "$asset_dir"

echo "Downloading ${RELEASE_REPOSITORY} release ${RELEASE_TAG}"
gh release download "$RELEASE_TAG" \
  --repo "$RELEASE_REPOSITORY" \
  --dir "$asset_dir"

asset_count="$(find "$asset_dir" -maxdepth 1 -type f | wc -l | tr -d ' ')"
installer_count="$(find "$asset_dir" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.zip' \) | wc -l | tr -d ' ')"
metadata_count="$(find "$asset_dir" -maxdepth 1 -type f -name '*.yml' | wc -l | tr -d ' ')"

if [[ "$asset_count" -eq 0 || "$installer_count" -eq 0 || "$metadata_count" -eq 0 ]]; then
  echo "::error::Release assets are incomplete (assets=${asset_count}, installers=${installer_count}, metadata=${metadata_count})."
  exit 1
fi

(
  cd "$asset_dir"
  find . -maxdepth 1 -type f ! -name 'SHA256SUMS' ! -name 'release.json' -print0 \
    | sort -z \
    | xargs -0 sha256sum > SHA256SUMS
)

ASSET_DIR="$asset_dir" \
DESTINATION_PREFIX="$destination_prefix" \
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

asset_dir = Path(os.environ["ASSET_DIR"])
base_url = os.environ["R2_PUBLIC_BASE_URL"].rstrip("/")
destination_prefix = os.environ["DESTINATION_PREFIX"].strip("/")

assets = []
for path in sorted(asset_dir.iterdir(), key=lambda item: item.name.lower()):
    if not path.is_file() or path.name == "release.json":
        continue
    assets.append({
        "name": path.name,
        "size": path.stat().st_size,
        "url": f"{base_url}/{destination_prefix}/{quote(path.name)}",
    })

manifest = {
    "edition": os.environ["R2_EDITION"],
    "channel": "prerelease" if "-" in os.environ["RELEASE_TAG"] else "stable",
    "tag": os.environ["RELEASE_TAG"],
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "assets": assets,
}
(asset_dir / "release.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"

r2_destination="s3://${R2_BUCKET}/${destination_prefix}/"
echo "Uploading immutable release assets to ${r2_destination}"
aws s3 sync "$asset_dir/" "$r2_destination" \
  --endpoint-url "$R2_ENDPOINT" \
  --delete \
  --exclude '*.yml' \
  --exclude 'release.json' \
  --cache-control 'public,max-age=31536000,immutable' \
  --only-show-errors \
  --no-progress

while IFS= read -r -d '' metadata_file; do
  metadata_name="$(basename "$metadata_file")"
  if [[ "$metadata_name" == "release.json" ]]; then
    content_type="application/json"
  else
    content_type="text/yaml"
  fi
  aws s3 cp "$metadata_file" "${r2_destination}${metadata_name}" \
    --endpoint-url "$R2_ENDPOINT" \
    --cache-control 'no-cache,no-store,must-revalidate' \
    --content-type "$content_type" \
    --only-show-errors \
    --no-progress
done < <(find "$asset_dir" -maxdepth 1 -type f \( -name '*.yml' -o -name 'release.json' \) -print0)

public_base="${R2_PUBLIC_BASE_URL%/}/${destination_prefix}"
curl --fail --silent --show-error --retry 5 --retry-all-errors \
  "${public_base}/release.json" >/dev/null

while IFS= read -r -d '' metadata_file; do
  metadata_name="$(basename "$metadata_file")"
  curl --fail --silent --show-error --retry 5 --retry-all-errors \
    "${public_base}/${metadata_name}" >/dev/null
done < <(find "$asset_dir" -maxdepth 1 -type f -name '*.yml' -print0)

echo "R2 mirror ready: ${public_base}/release.json"
