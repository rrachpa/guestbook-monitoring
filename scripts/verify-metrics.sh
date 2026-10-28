#!/usr/bin/env bash
# Checks that Prometheus is scraping the Guestbook frontend and backend.
# Requires: kubectl (pointed at the cluster), curl, jq.
set -euo pipefail

PORT="${PORT:-9090}"
PROM="http://localhost:${PORT}"

echo "Port-forwarding Prometheus to localhost:${PORT} ..."
kubectl -n monitoring port-forward svc/kps-prometheus "${PORT}:9090" >/dev/null 2>&1 &
PF_PID=$!
trap 'kill ${PF_PID} 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  curl -sf "${PROM}/-/ready" >/dev/null 2>&1 && break
  sleep 1
done

echo
echo "== Guestbook scrape targets (expect 5 'up': 3 frontend pods, redis-leader, redis-replica)"
curl -s "${PROM}/api/v1/targets?state=active" | jq -r '
  .data.activeTargets[]
  | select(.labels.namespace == "guestbook")
  | "\(.health)\t\(.labels.job)\t\(.labels.pod)\t\(.scrapeUrl)"' | column -t

query() {
  local q="$1"
  echo
  echo "== ${q}"
  curl -s --get "${PROM}/api/v1/query" --data-urlencode "query=${q}" | jq -r '
    if (.data.result | length) == 0 then "  (no data yet - wait a minute and re-run)"
    else .data.result[] | "  \(.metric.pod // .metric.app // "total")\t\(.value[1])" end'
}

query 'sum by (pod) (rate(apache_accesses_total{namespace="guestbook"}[2m]))'
query 'apache_up{namespace="guestbook"}'
query 'redis_up{namespace="guestbook"}'
query 'sum by (app) (rate(redis_commands_processed_total{namespace="guestbook"}[2m]))'
query 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook", container!=""}[2m]))'
