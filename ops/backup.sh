#!/bin/sh
# Nightly backup of Grove's own database and the shared runner's, run as the Cloud Run job "backups"
# (project makewithgrove) at 03:00 UTC. Each dump goes to gs://makewithgrove-backups/<db>/<date>.sql.gz,
# kept for 35 days. Restore with: gcloud storage cat <file> | gunzip | psql "$DATABASE_URL"
set -eu
apk add --no-cache curl >/dev/null
TOKEN=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
DAY=$(date -u +%Y-%m-%d)
fail=0
for pair in "grove:$GROVE_DATABASE_URL" "runner:$RUNNER_DATABASE_URL"; do
  name=${pair%%:*}; url=${pair#*:}
  file=/tmp/$name.sql.gz
  if pg_dump --no-owner --no-privileges "$url" | gzip -9 > "$file" && [ "$(gzip -dc "$file" | head -c 100 | wc -c)" -gt 0 ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
      --data-binary @"$file" "https://storage.googleapis.com/upload/storage/v1/b/makewithgrove-backups/o?uploadType=media&name=$name/$DAY.sql.gz")
    echo "$name: $(wc -c < "$file") bytes, upload $code"
    [ "$code" = "200" ] || fail=1
  else
    echo "$name: pg_dump failed" >&2; fail=1
  fi
done
exit $fail
