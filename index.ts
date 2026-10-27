// Guestbook + Prometheus + Grafana.
//
// Deploys the Pulumi Kubernetes Guestbook example into the "guestbook" namespace with metrics
// exporters, and the kube-prometheus-stack Helm chart (Prometheus Operator, Prometheus,
// Grafana, kube-state-metrics, node-exporter) into the "monitoring" namespace.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { createGuestbook } from "./guestbook";
import { createMonitoring, RELEASE_NAME } from "./monitoring";

const config = new pulumi.Config();

// Minikube/kind have no LoadBalancer implementation. When isMinikube is true the frontend uses
// ClusterIP and Grafana uses NodePort, as in the original example.
const isMinikube = config.getBoolean("isMinikube") ?? false;
const grafanaServiceType = (config.get("grafanaServiceType") ?? (isMinikube ? "NodePort" : "LoadBalancer")) as
    "LoadBalancer" | "NodePort";
if (grafanaServiceType !== "LoadBalancer" && grafanaServiceType !== "NodePort") {
    throw new Error(`grafanaServiceType must be "LoadBalancer" or "NodePort", got "${grafanaServiceType}"`);
}
const grafanaNodePort = config.getNumber("grafanaNodePort") ?? 30300;
const adminUser = config.get("grafanaAdminUser") ?? "admin";

// Use a password from config if one is set (pulumi config set --secret grafanaAdminPassword ...),
// otherwise generate one. Either way it is stored encrypted in the stack state.
const configuredPassword = config.getSecret("grafanaAdminPassword");
const adminPassword: pulumi.Output<string> = configuredPassword
    ?? new random.RandomPassword("grafana-admin-password", { length: 20, special: false }).result;

//
// Namespaces
//
const guestbookNs = new k8s.core.v1.Namespace("guestbook", { metadata: { name: "guestbook" } });
const monitoringNs = new k8s.core.v1.Namespace("monitoring", { metadata: { name: "monitoring" } });

//
// Guestbook application (with exporters)
//
const guestbook = createGuestbook({
    namespace: guestbookNs.metadata.name,
    isMinikube,
    apacheExporterImage: config.get("apacheExporterImage") ?? "quay.io/prometheuscommunity/apache-exporter:v1.0.8",
    redisExporterImage: config.get("redisExporterImage") ?? "oliver006/redis_exporter:v1.62.0",
    loadGeneratorImage: config.get("loadGeneratorImage") ?? "curlimages/curl:8.10.1",
    enableLoadGenerator: config.getBoolean("enableLoadGenerator") ?? true,
});

//
// Monitoring stack
//
const monitoring = createMonitoring({
    namespace: monitoringNs,
    guestbookNamespace: guestbookNs.metadata.name,
    chartVersion: config.get("kubePrometheusStackVersion"),
    grafanaServiceType,
    grafanaNodePort,
    grafanaAdminUser: adminUser,
    grafanaAdminPassword: adminPassword,
    dependsOn: [monitoringNs],
});

//
// Outputs
//
export const frontendIp = guestbook.frontendAddress;

export const grafanaUrl = grafanaServiceType === "NodePort"
    ? pulumi.output(`http://<node-ip>:${grafanaNodePort}  (minikube: run "minikube service -n monitoring ${RELEASE_NAME}-grafana --url")`)
    : monitoring.grafanaService.status.apply(s => {
        const ingress = s?.loadBalancer?.ingress?.[0];
        const host = ingress?.ip ?? ingress?.hostname;
        return host ? `http://${host}` : "pending: the LoadBalancer has no address yet; run `pulumi refresh` shortly";
    });

// Read the password with: pulumi stack output grafanaAdminPassword --show-secrets
export const grafanaAdminUser = adminUser;
export const grafanaAdminPassword = pulumi.secret(adminPassword);

// Works on any cluster, including ones without a LoadBalancer.
export const grafanaPortForward = `kubectl -n monitoring port-forward svc/${RELEASE_NAME}-grafana 3000:80   # then open http://localhost:3000`;
export const prometheusPortForward = `kubectl -n monitoring port-forward svc/${RELEASE_NAME}-prometheus 9090:9090   # then open http://localhost:9090/targets`;
export const grafanaDashboardPath = "/d/guestbook-overview/guestbook-overview";
