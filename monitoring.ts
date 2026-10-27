// Prometheus + Grafana, deployed with the kube-prometheus-stack Helm chart, plus the
// ServiceMonitors that tell Prometheus to scrape the Guestbook and a provisioned dashboard.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { METRICS_LABEL, METRICS_PORT_NAME } from "./guestbook";
import { guestbookDashboard } from "./dashboard";

// fullnameOverride makes the chart's resource names short and predictable:
// kps-prometheus, kps-operator, ... and the Grafana subchart's Service is "<release>-grafana".
export const RELEASE_NAME = "kps";

export interface MonitoringArgs {
    namespace: k8s.core.v1.Namespace;
    guestbookNamespace: pulumi.Input<string>;
    chartVersion?: string;
    grafanaServiceType: "LoadBalancer" | "NodePort";
    grafanaNodePort: number;
    grafanaAdminUser: string;
    grafanaAdminPassword: pulumi.Input<string>;
    dependsOn: pulumi.Resource[];
}

export function createMonitoring(args: MonitoringArgs) {
    const ns = args.namespace.metadata.name;

    const stack = new k8s.helm.v3.Release("kube-prometheus-stack", {
        name: RELEASE_NAME,
        chart: "kube-prometheus-stack",
        version: args.chartVersion,             // undefined = latest
        namespace: ns,
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        timeout: 900,
        values: {
            fullnameOverride: RELEASE_NAME,
            // Not needed for this exercise; keeps the footprint small on a laptop cluster.
            alertmanager: { enabled: false },
            prometheus: {
                prometheusSpec: {
                    // By default the operator only picks up ServiceMonitors labelled with this
                    // Helm release. Turning that off lets it discover our ServiceMonitors in any
                    // namespace without coupling them to the release name.
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    scrapeInterval: "15s",
                    retention: "2d",
                    resources: { requests: { cpu: "100m", memory: "400Mi" } },
                },
            },
            grafana: {
                adminUser: args.grafanaAdminUser,
                adminPassword: args.grafanaAdminPassword,
                service: args.grafanaServiceType === "NodePort"
                    ? { type: "NodePort", port: 80, nodePort: args.grafanaNodePort }
                    : { type: "LoadBalancer", port: 80 },
                // The dashboard sidecar loads any ConfigMap in this namespace labelled
                // grafana_dashboard=1 (see the ConfigMap below).
                sidecar: { dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1" } },
            },
        },
    }, { dependsOn: args.dependsOn });

    // ServiceMonitor CRDs are installed by the chart, so these must wait for the release.
    const smOpts: pulumi.CustomResourceOptions = { dependsOn: [stack] };

    const frontendMonitor = new k8s.apiextensions.CustomResource("guestbook-frontend", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "guestbook-frontend",
            namespace: args.guestbookNamespace,
            labels: { app: "guestbook" },
        },
        spec: {
            selector: { matchLabels: { [METRICS_LABEL]: "true", tier: "frontend" } },
            endpoints: [{ port: METRICS_PORT_NAME, interval: "15s", path: "/metrics" }],
            // Copy these Service labels onto every scraped series, so queries and the
            // dashboard can filter by component.
            targetLabels: ["app", "tier"],
        },
    }, smOpts);

    const backendMonitor = new k8s.apiextensions.CustomResource("guestbook-backend", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "guestbook-backend",
            namespace: args.guestbookNamespace,
            labels: { app: "guestbook" },
        },
        spec: {
            selector: { matchLabels: { [METRICS_LABEL]: "true", tier: "backend" } },
            endpoints: [{ port: METRICS_PORT_NAME, interval: "15s", path: "/metrics" }],
            targetLabels: ["app", "tier"],
        },
    }, smOpts);

    // Stretch goal: a Guestbook dashboard, provisioned through Grafana's dashboard sidecar.
    const dashboard = new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            name: "guestbook-dashboard",
            namespace: ns,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook.json": JSON.stringify(guestbookDashboard, null, 2) },
    }, { dependsOn: [stack] });

    // Read the Grafana Service back after the release so we can export its address.
    const grafanaService = k8s.core.v1.Service.get("grafana-service",
        pulumi.interpolate`${stack.status.namespace}/${stack.status.name}-grafana`,
        { dependsOn: [stack] });

    return { stack, grafanaService, frontendMonitor, backendMonitor, dashboard };
}
