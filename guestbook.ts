// The Guestbook application from pulumi/examples (kubernetes-ts-guestbook/simple),
// extended so that every component exposes Prometheus metrics:
//
//   * frontend (PHP on Apache)  -> apache_exporter sidecar reading Apache's mod_status page
//   * redis-leader / replica    -> redis_exporter sidecar
//
// Each component also gets a ClusterIP "metrics" Service. The metrics ports are kept off the
// public frontend LoadBalancer so metrics are only reachable inside the cluster.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Labels used by the ServiceMonitors (see monitoring.ts) to find the metrics Services.
export const METRICS_LABEL = "guestbook.example.com/metrics";
export const METRICS_PORT_NAME = "metrics";

export const APACHE_EXPORTER_PORT = 9117;
export const REDIS_EXPORTER_PORT = 9121;

export interface GuestbookArgs {
    namespace: pulumi.Input<string>;
    isMinikube: boolean;
    apacheExporterImage: string;
    redisExporterImage: string;
    loadGeneratorImage: string;
    enableLoadGenerator: boolean;
}

const sidecarResources = {
    requests: { cpu: "10m", memory: "16Mi" },
    limits: { cpu: "100m", memory: "64Mi" },
};

function redisExporterSidecar(image: string): k8s.types.input.core.v1.Container {
    return {
        name: "redis-exporter",
        image,
        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
        ports: [{ name: METRICS_PORT_NAME, containerPort: REDIS_EXPORTER_PORT }],
        resources: sidecarResources,
    };
}

// A ClusterIP Service that exposes only the exporter port of a component.
function metricsService(name: string, ns: pulumi.Input<string>, app: string, tier: string,
                        port: number, opts?: pulumi.CustomResourceOptions): k8s.core.v1.Service {
    return new k8s.core.v1.Service(`${name}-metrics`, {
        metadata: {
            name: `${name}-metrics`,
            namespace: ns,
            labels: { app, tier, [METRICS_LABEL]: "true" },
        },
        spec: {
            type: "ClusterIP",
            selector: { app },
            ports: [{ name: METRICS_PORT_NAME, port, targetPort: METRICS_PORT_NAME }],
        },
    }, opts);
}

export function createGuestbook(args: GuestbookArgs) {
    const ns = args.namespace;

    //
    // REDIS LEADER (backend)
    //
    const redisLeaderLabels = { app: "redis-leader", tier: "backend" };
    const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
        metadata: { namespace: ns },
        spec: {
            selector: { matchLabels: redisLeaderLabels },
            template: {
                metadata: { labels: redisLeaderLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-leader",
                            image: "redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ containerPort: 6379 }],
                        },
                        redisExporterSidecar(args.redisExporterImage),
                    ],
                },
            },
        },
    });
    const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
        metadata: { name: "redis-leader", namespace: ns, labels: redisLeaderLabels },
        spec: {
            ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
            selector: redisLeaderLabels,
        },
    });
    const redisLeaderMetrics = metricsService("redis-leader", ns, "redis-leader", "backend",
                                              REDIS_EXPORTER_PORT);

    //
    // REDIS REPLICA (backend)
    //
    const redisReplicaLabels = { app: "redis-replica", tier: "backend" };
    const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
        metadata: { namespace: ns },
        spec: {
            selector: { matchLabels: redisReplicaLabels },
            template: {
                metadata: { labels: redisReplicaLabels },
                spec: {
                    containers: [
                        {
                            name: "replica",
                            image: "pulumi/guestbook-redis-replica",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ containerPort: 6379 }],
                        },
                        redisExporterSidecar(args.redisExporterImage),
                    ],
                },
            },
        },
    }, { dependsOn: [redisLeaderService] });
    const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
        metadata: { name: "redis-replica", namespace: ns, labels: redisReplicaLabels },
        spec: {
            ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
            selector: redisReplicaLabels,
        },
    });
    const redisReplicaMetrics = metricsService("redis-replica", ns, "redis-replica", "backend",
                                               REDIS_EXPORTER_PORT);

    //
    // FRONTEND
    //
    // The frontend image is PHP on Debian's Apache. Instead of relying on the image's default
    // config, we mount a small conf file that guarantees mod_status is loaded and that
    // /server-status is served to localhost only. The exporter sidecar shares the pod's
    // network namespace, so it reaches Apache on localhost while outside clients cannot.
    const apacheStatusConf = new k8s.core.v1.ConfigMap("frontend-apache-status", {
        metadata: { namespace: ns },
        data: {
            "zz-server-status.conf": [
                "<IfModule !status_module>",
                "    LoadModule status_module /usr/lib/apache2/modules/mod_status.so",
                "</IfModule>",
                "ExtendedStatus On",
                "<Location \"/server-status\">",
                "    SetHandler server-status",
                "    Require local",
                "</Location>",
                "",
            ].join("\n"),
        },
    });

    const frontendLabels = { app: "frontend", tier: "frontend" };
    const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
        metadata: { namespace: ns },
        spec: {
            selector: { matchLabels: frontendLabels },
            replicas: 3,
            template: {
                metadata: { labels: frontendLabels },
                spec: {
                    containers: [
                        {
                            name: "frontend",
                            image: "pulumi/guestbook-php-redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ name: "http", containerPort: 80 }],
                            volumeMounts: [{
                                name: "apache-status",
                                mountPath: "/etc/apache2/conf-enabled/zz-server-status.conf",
                                subPath: "zz-server-status.conf",
                                readOnly: true,
                            }],
                        },
                        {
                            name: "apache-exporter",
                            image: args.apacheExporterImage,
                            args: ["--scrape_uri=http://localhost/server-status?auto"],
                            ports: [{ name: METRICS_PORT_NAME, containerPort: APACHE_EXPORTER_PORT }],
                            resources: sidecarResources,
                        },
                    ],
                    volumes: [{ name: "apache-status", configMap: { name: apacheStatusConf.metadata.name } }],
                },
            },
        },
    }, { dependsOn: [redisLeaderService, redisReplicaService] });

    const frontendService = new k8s.core.v1.Service("frontend", {
        metadata: { name: "frontend", namespace: ns, labels: frontendLabels },
        spec: {
            type: args.isMinikube ? "ClusterIP" : "LoadBalancer",
            ports: [{ name: "http", port: 80, targetPort: "http" }],
            selector: frontendLabels,
        },
    });
    const frontendMetrics = metricsService("frontend", ns, "frontend", "frontend",
                                           APACHE_EXPORTER_PORT);

    //
    // LOAD GENERATOR (optional)
    //
    // Sends a steady trickle of page views and API reads so the dashboard has data to show.
    // Each API read makes the frontend query Redis, so backend metrics move as well.
    if (args.enableLoadGenerator) {
        new k8s.apps.v1.Deployment("load-generator", {
            metadata: { namespace: ns },
            spec: {
                selector: { matchLabels: { app: "load-generator" } },
                replicas: 1,
                template: {
                    metadata: { labels: { app: "load-generator" } },
                    spec: {
                        containers: [{
                            name: "curl",
                            image: args.loadGeneratorImage,
                            command: ["/bin/sh", "-c"],
                            args: [[
                                "while true; do",
                                "  curl -s -o /dev/null http://frontend/ || true;",
                                "  curl -s -o /dev/null 'http://frontend/guestbook.php?cmd=get&key=messages' || true;",
                                "  sleep 0.5;",
                                "done",
                            ].join("\n")],
                            resources: sidecarResources,
                        }],
                    },
                },
            },
        }, { dependsOn: [frontendService, frontendDeployment] });
    }

    const frontendAddress = args.isMinikube
        ? frontendService.spec.clusterIP
        : frontendService.status.apply(s =>
            s?.loadBalancer?.ingress?.[0]?.ip ?? s?.loadBalancer?.ingress?.[0]?.hostname ?? "pending");

    return {
        frontendService,
        frontendAddress,
        metricsServices: [frontendMetrics, redisLeaderMetrics, redisReplicaMetrics],
        deployments: [frontendDeployment, redisLeaderDeployment, redisReplicaDeployment],
    };
}
