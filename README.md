# Guestbook with Prometheus and Grafana Monitoring

This project extends the Pulumi [Kubernetes Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook) so the application can be monitored with **Prometheus** and **Grafana**. Everything is deployed with Pulumi (TypeScript). It covers:

- Prometheus and Grafana, deployed with the `kube-prometheus-stack` Helm chart.
- Metrics from the Guestbook **frontend** (request counts, Apache workers, bytes sent) and **backend** (Redis commands, clients, memory), scraped through `ServiceMonitor` resources.
- Pod CPU, memory and restart metrics from cAdvisor and kube-state-metrics.
- Grafana exposed as a **LoadBalancer** (or **NodePort** on local clusters). Its URL and admin credentials are Pulumi stack outputs.
- **Stretch goal:** a provisioned *Guestbook Overview* dashboard.

## Architecture

```
 namespace: guestbook                                namespace: monitoring
┌───────────────────────────────────────────────┐   ┌──────────────────────────────────┐
│ frontend pod (x3)                             │   │ Prometheus Operator               │
│  ├─ php/apache  :80  ──/server-status──┐      │   │ Prometheus  ◄── ServiceMonitors ──┼─┐
│  └─ apache-exporter :9117 /metrics ◄───┘      │   │ Grafana (LoadBalancer/NodePort)   │ │
│ redis-leader pod                              │   │   └─ "Guestbook Overview" dashboard│ │
│  ├─ redis :6379                               │   │ kube-state-metrics, node-exporter │ │
│  └─ redis-exporter :9121 /metrics             │   └──────────────────────────────────┘ │
│ redis-replica pod                             │                                        │
│  ├─ redis :6379                               │   ServiceMonitor guestbook-frontend ───┤
│  └─ redis-exporter :9121 /metrics             │   ServiceMonitor guestbook-backend  ───┘
│ *-metrics ClusterIP Services (port "metrics") │   (select *-metrics Services by label)
│ load-generator (curl loop, optional)          │
└───────────────────────────────────────────────┘
```

### How the metrics are exposed

The Guestbook containers don't publish Prometheus metrics themselves, so each pod gets an exporter **sidecar**. This leaves the application images unchanged.

| Component | Exporter | Example metrics |
|---|---|---|
| Frontend (PHP on Apache) | [`apache_exporter`](https://github.com/Lusitaniae/apache_exporter) reads Apache's `mod_status` page over `localhost` | `apache_accesses_total` (requests), `apache_workers`, `apache_sent_kilobytes_total`, `apache_up` |
| Redis leader and replica | [`redis_exporter`](https://github.com/oliver006/redis_exporter) | `redis_commands_processed_total`, `redis_connected_clients`, `redis_memory_used_bytes`, `redis_up` |
| All pods | cAdvisor and kube-state-metrics (included in the chart) | `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`, `kube_pod_container_status_restarts_total` |

The frontend mounts a small Apache config file (`conf-enabled/zz-server-status.conf`). It makes sure `mod_status` is loaded and serves `/server-status` **only to localhost**. The exporter can read it because it shares the pod's network, but outside users cannot.

Each component has a separate `ClusterIP` Service named `*-metrics` that exposes only the exporter port. This keeps metrics off the public frontend LoadBalancer. Two `ServiceMonitor`s, `guestbook-frontend` and `guestbook-backend`, select these Services by label. They also copy the `app` and `tier` labels onto every series, so you can filter by component.

## Project layout

| File | Purpose |
|---|---|
| `index.ts` | Configuration, namespaces, and stack outputs |
| `guestbook.ts` | The original Guestbook plus exporter sidecars, metrics Services, and the load generator |
| `monitoring.ts` | `kube-prometheus-stack` Helm release, ServiceMonitors, Grafana dashboard ConfigMap |
| `dashboard.ts` | The Grafana dashboard, defined in code |
| `scripts/verify-metrics.sh` | Checks from the command line that Prometheus is scraping the Guestbook |

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) 3.x and Node.js 18+
- A Kubernetes cluster, with `kubectl` configured to use it. This works on a cloud cluster (EKS, GKE, AKS) or locally on minikube, kind or Docker Desktop. Allow about **4 GB RAM** for the monitoring stack.
- `curl` and `jq` for the verification script (optional)

## Deploy

```bash
npm install
pulumi stack init dev          # or: pulumi login --local   to keep state on your machine

# Local cluster (minikube / kind / Docker Desktop) - no LoadBalancer support:
pulumi config set isMinikube true

# Cloud cluster - Grafana gets a LoadBalancer:
pulumi config set isMinikube false

pulumi up
```

The first `pulumi up` takes about 3-6 minutes, most of it waiting for the Helm chart to become ready.

### Optional settings

| Config key | Default | Meaning |
|---|---|---|
| `isMinikube` | `false` | `true`: frontend uses ClusterIP and Grafana uses NodePort |
| `grafanaServiceType` | from `isMinikube` | Force `LoadBalancer` or `NodePort` |
| `grafanaNodePort` | `30300` | Node port when Grafana uses NodePort |
| `grafanaAdminUser` | `admin` | Grafana admin username |
| `grafanaAdminPassword` | generated | Set your own password: `pulumi config set --secret grafanaAdminPassword <pw>` |
| `enableLoadGenerator` | `true` | Runs a small curl loop so the dashboard has traffic |
| `kubePrometheusStackVersion` | latest | Pin the chart version, e.g. `pulumi config set kubePrometheusStackVersion <version>` |
| `apacheExporterImage`, `redisExporterImage`, `loadGeneratorImage` | see `index.ts` | Override exporter and load generator images |

## Grafana access URL and admin credentials

After `pulumi up`, the stack outputs show how to reach Grafana:

```bash
pulumi stack output grafanaUrl                       # Grafana URL
pulumi stack output grafanaAdminUser                 # admin
pulumi stack output grafanaAdminPassword --show-secrets
```

- **Username:** `admin` (or the value of `grafanaAdminUser`)
- **Password:** a random 20-character password created on the first deploy. Pulumi stores it encrypted in the stack, which is why `--show-secrets` is needed. Running the command above prints it. If you prefer a fixed password, set `grafanaAdminPassword` as shown in the settings table.
- **URL:**
  - **LoadBalancer:** `http://<external-ip-or-hostname>` (port 80). If the output shows `pending`, the cloud LoadBalancer was still being created; run `pulumi refresh` and check again.
  - **NodePort:** `http://<node-ip>:30300`. On minikube, `minikube service -n monitoring kps-grafana --url` prints the exact URL.
  - **Any cluster:** `kubectl -n monitoring port-forward svc/kps-grafana 3000:80`, then open http://localhost:3000. This is also the `grafanaPortForward` output.

The dashboard is at **Dashboards → Guestbook Overview**, or `<grafana-url>/d/guestbook-overview/guestbook-overview`.

## Verify that Prometheus is scraping the Guestbook

### Option 1: run the script

```bash
./scripts/verify-metrics.sh
```

Example of the expected output (pod names will differ):

```
== Guestbook scrape targets (expect 5 'up': 3 frontend pods, redis-leader, redis-replica)
up  frontend-metrics       frontend-6f9c...-abcde      http://10.244.0.12:9117/metrics
up  frontend-metrics       frontend-6f9c...-fghij      http://10.244.0.13:9117/metrics
up  frontend-metrics       frontend-6f9c...-klmno      http://10.244.0.14:9117/metrics
up  redis-leader-metrics   redis-leader-7d8...-pqrst   http://10.244.0.10:9121/metrics
up  redis-replica-metrics  redis-replica-5b...-uvwxy   http://10.244.0.11:9121/metrics

== sum by (pod) (rate(apache_accesses_total{namespace="guestbook"}[2m]))
  frontend-6f9c...-abcde   1.32
  ...
```

### Option 2: the Prometheus UI

1. `kubectl -n monitoring port-forward svc/kps-prometheus 9090:9090`
2. Open http://localhost:9090/targets and find `serviceMonitor/guestbook/guestbook-frontend/0` and `serviceMonitor/guestbook/guestbook-backend/0`. All 5 endpoints should show **UP**.
3. On the **Graph/Query** page, run these queries:

| Query | What it shows |
|---|---|
| `up{namespace="guestbook"}` | 1 for each healthy scrape target |
| `sum by (pod) (rate(apache_accesses_total{namespace="guestbook"}[2m]))` | Frontend requests per second, per pod |
| `apache_up{namespace="guestbook"}` | 1 if the exporter can read Apache's status page |
| `sum by (app) (rate(redis_commands_processed_total{namespace="guestbook"}[2m]))` | Redis commands per second, leader vs. replica |
| `sum by (pod) (container_memory_working_set_bytes{namespace="guestbook", container!=""})` | Memory used by each pod |

### Option 3: Grafana

Open the **Guestbook Overview** dashboard. With the load generator running, *Frontend request rate* should show a few requests per second within a minute or two, and the Redis panels should show the replica serving reads.

You can also create traffic yourself by opening the Guestbook frontend (`pulumi stack output frontendIp`, or `kubectl -n guestbook port-forward svc/frontend 8080:80` and http://localhost:8080) and adding a few messages.

## Dashboard (stretch goal)

`dashboard.ts` defines the *Guestbook Overview* dashboard. Pulumi stores it in a ConfigMap labelled `grafana_dashboard: "1"`, and Grafana's sidecar loads it automatically. The dashboard has four rows:

- **Health:** total frontend request rate, frontend pods reporting, Redis instances up, scrape targets down
- **Frontend:** request rate per pod, busy/idle Apache workers, bytes sent
- **Backend:** Redis commands per second (leader vs. replica), connected clients, memory used
- **Pod resource usage:** CPU, memory working set, container restarts

## Design decisions and limitations

- **Helm chart instead of raw manifests.** `kube-prometheus-stack` provides the Prometheus Operator and the `ServiceMonitor` CRD, comes with Grafana already connected to Prometheus, and includes cAdvisor and kube-state-metrics for resource usage. `serviceMonitorSelectorNilUsesHelmValues: false` lets Prometheus discover ServiceMonitors in any namespace. Without it, they would need to carry the Helm release label.
- **Sidecars instead of changing the application.** Exporters add metrics without rebuilding the Guestbook images.
- **Metrics stay inside the cluster.** Exporter ports are only on ClusterIP Services, and `/server-status` only answers localhost.
- **No HTTP error-rate metric.** Apache's status page reports request counts but not response codes, so the dashboard uses scrape health and `apache_up` instead of a 5xx rate. Measuring true error rates would need an ingress controller with metrics (for example ingress-nginx) or instrumenting the PHP app.
- **Small footprint.** Alertmanager is disabled and Prometheus keeps 2 days of data. Both are easy to change in `monitoring.ts`.
- **Chart version.** The latest chart is installed unless you set `kubePrometheusStackVersion`. Pin it for repeatable deploys.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pulumi up` waits a long time on `kube-prometheus-stack` on a local cluster | Make sure `isMinikube=true`. Helm waits for LoadBalancer IPs that local clusters never assign. You can also run `minikube tunnel`. |
| Targets are UP but `apache_up` is 0 | The exporter can't read `/server-status`. Check from inside a frontend pod: `kubectl -n guestbook exec $(kubectl -n guestbook get pod -l app=frontend -o name | head -1) -c frontend -- curl -s 'http://localhost/server-status?auto'` |
| `grafanaUrl` shows `pending` | The cloud LoadBalancer is still being created. Run `pulumi refresh`, or use the port-forward command. |
| No data in resource panels on kind | Some local clusters limit kubelet/cAdvisor scraping. Application metrics still work. |

## Clean up

```bash
pulumi destroy
pulumi stack rm dev
```
