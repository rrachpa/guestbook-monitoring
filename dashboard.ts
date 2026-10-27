// Grafana dashboard for the Guestbook, defined in code so it is versioned with the stack.
// Metric sources:
//   apache_*                      apache_exporter sidecar on each frontend pod
//   redis_*                       redis_exporter sidecar on the Redis leader and replica
//   container_* / kube_pod_*      cAdvisor and kube-state-metrics (part of kube-prometheus-stack)

const DS = { type: "prometheus", uid: "${datasource}" };
const NS = 'namespace="$namespace"';

let nextId = 1;

interface PanelOpts {
    title: string;
    exprs: { expr: string; legend?: string }[];
    unit?: string;
    x: number; y: number; w: number; h: number;
    type?: "timeseries" | "stat";
    description?: string;
}

function panel(o: PanelOpts) {
    const type = o.type ?? "timeseries";
    return {
        id: nextId++,
        type,
        title: o.title,
        description: o.description,
        datasource: DS,
        gridPos: { x: o.x, y: o.y, w: o.w, h: o.h },
        fieldConfig: {
            defaults: {
                unit: o.unit ?? "short",
                ...(type === "timeseries"
                    ? { custom: { drawStyle: "line", lineWidth: 2, fillOpacity: 10, showPoints: "never" } }
                    : { color: { mode: "thresholds" } }),
            },
            overrides: [],
        },
        options: type === "stat"
            ? { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
                colorMode: "value", graphMode: "area", textMode: "auto" }
            : { legend: { displayMode: "list", placement: "bottom", showLegend: true },
                tooltip: { mode: "multi", sort: "desc" } },
        targets: o.exprs.map((e, i) => ({
            datasource: DS,
            expr: e.expr,
            legendFormat: e.legend ?? "",
            refId: String.fromCharCode(65 + i),
        })),
    };
}

function row(title: string, y: number) {
    return { id: nextId++, type: "row", title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] };
}

export const guestbookDashboard = {
    uid: "guestbook-overview",
    title: "Guestbook Overview",
    tags: ["guestbook", "pulumi"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    editable: true,
    refresh: "30s",
    time: { from: "now-30m", to: "now" },
    templating: {
        list: [
            { name: "datasource", label: "Data source", type: "datasource", query: "prometheus",
              current: {}, hide: 0, refresh: 1 },
            { name: "namespace", label: "Namespace", type: "constant", query: "guestbook", hide: 2 },
        ],
    },
    panels: [
        // ---- Health ---------------------------------------------------------------------
        row("Health", 0),
        panel({ type: "stat", title: "Frontend request rate", unit: "reqps", x: 0, y: 1, w: 6, h: 4,
            exprs: [{ expr: `sum(rate(apache_accesses_total{${NS}}[2m]))` }] }),
        panel({ type: "stat", title: "Frontend pods reporting", x: 6, y: 1, w: 6, h: 4,
            description: "Frontend pods whose Apache status page is readable by the exporter.",
            exprs: [{ expr: `sum(apache_up{${NS}})` }] }),
        panel({ type: "stat", title: "Redis instances up", x: 12, y: 1, w: 6, h: 4,
            exprs: [{ expr: `sum(redis_up{${NS}})` }] }),
        panel({ type: "stat", title: "Scrape targets down", x: 18, y: 1, w: 6, h: 4,
            description: "Guestbook targets Prometheus failed to scrape on its last attempt (0 is healthy).",
            exprs: [{ expr: `count(up{${NS}} == 0) or vector(0)` }] }),

        // ---- Frontend -------------------------------------------------------------------
        row("Frontend (Apache / PHP)", 5),
        panel({ title: "Request rate by pod", unit: "reqps", x: 0, y: 6, w: 12, h: 8,
            exprs: [{ expr: `sum by (pod) (rate(apache_accesses_total{${NS}}[2m]))`, legend: "{{pod}}" }] }),
        panel({ title: "Apache workers", x: 12, y: 6, w: 6, h: 8,
            exprs: [{ expr: `sum by (state) (apache_workers{${NS}})`, legend: "{{state}}" }] }),
        panel({ title: "Bytes sent", unit: "Bps", x: 18, y: 6, w: 6, h: 8,
            exprs: [{ expr: `sum(rate(apache_sent_kilobytes_total{${NS}}[2m])) * 1024`, legend: "sent" }] }),

        // ---- Backend --------------------------------------------------------------------
        row("Backend (Redis)", 14),
        panel({ title: "Redis commands per second", unit: "ops", x: 0, y: 15, w: 12, h: 8,
            exprs: [{ expr: `sum by (app) (rate(redis_commands_processed_total{${NS}}[2m]))`, legend: "{{app}}" }] }),
        panel({ title: "Connected clients", x: 12, y: 15, w: 6, h: 8,
            exprs: [{ expr: `sum by (app) (redis_connected_clients{${NS}})`, legend: "{{app}}" }] }),
        panel({ title: "Redis memory used", unit: "bytes", x: 18, y: 15, w: 6, h: 8,
            exprs: [{ expr: `sum by (app) (redis_memory_used_bytes{${NS}})`, legend: "{{app}}" }] }),

        // ---- Resources ------------------------------------------------------------------
        row("Pod resource usage", 23),
        panel({ title: "CPU usage by pod", unit: "cores", x: 0, y: 24, w: 10, h: 8,
            exprs: [{ expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{${NS}, container!="", container!="POD"}[2m]))`,
                      legend: "{{pod}}" }] }),
        panel({ title: "Memory working set by pod", unit: "bytes", x: 10, y: 24, w: 10, h: 8,
            exprs: [{ expr: `sum by (pod) (container_memory_working_set_bytes{${NS}, container!="", container!="POD"})`,
                      legend: "{{pod}}" }] }),
        panel({ type: "stat", title: "Container restarts", x: 20, y: 24, w: 4, h: 8,
            exprs: [{ expr: `sum(kube_pod_container_status_restarts_total{${NS}})` }] }),
    ],
};
