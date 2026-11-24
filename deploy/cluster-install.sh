#!/usr/bin/env bash
# Runs ON the IDP host (deploy.sh ships it from the artifact): installs or updates the k3s server that
# backs Compute -> Containers, its two Cluster Autoscalers, the `apps` namespace, the IDP's service
# account and the stale-node cleanup. Idempotent; k3s restarts only when its version or config changes.
# See vendy/DESIGN.md §13 and vendy/CONTRACTS.md §12.
set -euo pipefail
env_file=${1:?usage: cluster-install.sh <env-file> <image-id>}
image=${2:?usage: cluster-install.sh <env-file> <image-id>}
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'cluster-install: invalid image ID' >&2; exit 2; }
val() { grep -E "^$1=" "$env_file" | head -1 | cut -d= -f2-; }
for key in K3S_VERSION K3S_TOKEN CA_VERSION IDP_PUBLIC_IP AWS_REGION AWS_WORKER_GROUPS AZURE_READER_SECRET_ID \
  AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID AZURE_WORKERS_RG AZURE_WORKER_SCALE_SETS \
  AZURE_AUTOSCALER_CLIENT_ID; do
  [[ -n "$(val "$key")" ]] || { echo "cluster-install: missing $key" >&2; exit 2; }
done
k3s_version=$(val K3S_VERSION)
ca_version=$(val CA_VERSION)
public_ip=$(val IDP_PUBLIC_IP)
[[ "$k3s_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ && "$ca_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo 'cluster-install: invalid K3S_VERSION or CA_VERSION' >&2; exit 2; }
[[ "$public_ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo 'cluster-install: invalid IDP_PUBLIC_IP' >&2; exit 2; }
kubectl() { sudo k3s kubectl "$@"; }

# 1. k3s server: control plane only (tainted), cross-cloud WireGuard to workers (DESIGN.md §13.3).
config=$(cat <<EOF
token: "$(val K3S_TOKEN)"
# gateway-api-crd: its install job does not tolerate the server taint, so it stays pending and
# both autoscalers start a worker for it.
disable: [traefik, servicelb, gateway-api-crd]
node-taint: ["CriticalAddonsOnly=true:NoExecute"]
node-external-ip: "$public_ip"
flannel-backend: wireguard-native
flannel-external-ip: true
tls-san: ["$public_ip", "host.docker.internal"]
write-kubeconfig-mode: "0600"
EOF
)
sudo install -d -m 755 /etc/rancher/k3s
current_config=$(sudo cat /etc/rancher/k3s/config.yaml 2>/dev/null || true)
installed=$(k3s --version 2>/dev/null | awk 'NR==1 {print $3}' || true)
if [[ "$installed" != "$k3s_version" || "$current_config" != "$config" ]]; then
  echo "cluster-install: installing k3s $k3s_version (was: ${installed:-none})"
  printf '%s\n' "$config" | sudo tee /etc/rancher/k3s/config.yaml >/dev/null
  sudo chmod 600 /etc/rancher/k3s/config.yaml
  curl -sfL https://get.k3s.io | sudo env INSTALL_K3S_VERSION="$k3s_version" sh -s - server
fi
node=$(hostname)
end=$((SECONDS + 180))
until kubectl get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -qx True; do
  [[ $SECONDS -lt $end ]] || { echo 'cluster-install: k3s server not Ready after 3 minutes' >&2; sudo journalctl -u k3s --no-pager | tail -40 >&2; exit 1; }
  sleep 3
done

# 2. Workloads namespace, the IDP's service account (apps namespace only, plus node reads).
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: apps
  labels:
    pod-security.kubernetes.io/enforce: baseline
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: apps, namespace: apps }
spec:
  hard: { pods: "20", requests.cpu: "4", requests.memory: 4Gi, limits.memory: 4Gi }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: vendy-idp, namespace: apps }
---
apiVersion: v1
kind: Secret
metadata:
  name: vendy-idp-token
  namespace: apps
  annotations: { kubernetes.io/service-account.name: vendy-idp }
type: kubernetes.io/service-account-token
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: vendy-idp, namespace: apps }
rules:
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [""]
    resources: [services]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [""]
    resources: [pods, pods/log, events]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: vendy-idp, namespace: apps }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: vendy-idp }
subjects: [{ kind: ServiceAccount, name: vendy-idp, namespace: apps }]
EOF
end=$((SECONDS + 60))
until token=$(kubectl -n apps get secret vendy-idp-token -o jsonpath='{.data.token}' 2>/dev/null) && [[ -n "$token" ]]; do
  [[ $SECONDS -lt $end ]] || { echo 'cluster-install: service account token was not issued' >&2; exit 1; }
  sleep 2
done
# Backstage (uid 1000, like ubuntu) reads these through the read-only /kube mount.
install -d -m 750 /opt/idp/kube
umask 027
base64 -d <<< "$token" > /opt/idp/kube/token.tmp && mv /opt/idp/kube/token.tmp /opt/idp/kube/token
kubectl -n apps get secret vendy-idp-token -o jsonpath='{.data.ca\.crt}' | base64 -d > /opt/idp/kube/ca.crt.tmp
mv /opt/idp/kube/ca.crt.tmp /opt/idp/kube/ca.crt
umask 022

# 3. Cluster Autoscaler, one per cloud (DESIGN.md §13.4). Each has its own leader lease and status
# config map, and manages only its own explicit node groups.
nodes_flags() { tr ',' '\n' <<< "$1" | sed 's/^/            - --nodes=0:2:/'; }
# Only the host role reads the PEM. Turn off Docker logging for the secret-bearing pipe.
timeout 45 docker run --rm --pull never --log-driver none --entrypoint node \
  --env AWS_REGION="$(val AWS_REGION)" --env AZURE_READER_SECRET_ID="$(val AZURE_READER_SECRET_ID)" \
  "$image" /app/deploy/azure-autoscaler-secret.cjs "$(val AZURE_AUTOSCALER_CLIENT_ID)" \
  "$(val AZURE_TENANT_ID)" "$(val AZURE_SUBSCRIPTION_ID)" "$(val AZURE_WORKERS_RG)" | kubectl apply -f -
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata: { name: cluster-autoscaler, namespace: kube-system }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: cluster-autoscaler }
rules:
  - apiGroups: [""]
    resources: [events, endpoints]
    verbs: [create, patch]
  - apiGroups: [""]
    resources: [pods/eviction]
    verbs: [create]
  - apiGroups: [""]
    resources: [pods/status]
    verbs: [update]
  - apiGroups: [""]
    resources: [endpoints]
    verbs: [get, update]
  - apiGroups: [""]
    resources: [nodes]
    verbs: [watch, list, get, update, patch]
  - apiGroups: [""]
    resources: [namespaces, pods, services, replicationcontrollers, persistentvolumeclaims, persistentvolumes]
    verbs: [watch, list, get]
  - apiGroups: [extensions]
    resources: [replicasets, daemonsets]
    verbs: [watch, list, get]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets]
    verbs: [watch, list]
  - apiGroups: [apps]
    resources: [statefulsets, replicasets, daemonsets]
    verbs: [watch, list, get]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses, csinodes, csidrivers, csistoragecapacities, volumeattachments]
    verbs: [watch, list, get]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [watch, list, get]
  - apiGroups: [coordination.k8s.io]
    resources: [leases]
    verbs: [create, get, update, watch, list]
  # 1.37 lists DRA objects even when no driver is installed (missing from the upstream example).
  - apiGroups: [resource.k8s.io]
    resources: [resourceslices, resourceclaims, deviceclasses]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: cluster-autoscaler }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-autoscaler }
subjects: [{ kind: ServiceAccount, name: cluster-autoscaler, namespace: kube-system }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: cluster-autoscaler, namespace: kube-system }
rules:
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [create, list, watch, get, update, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: cluster-autoscaler, namespace: kube-system }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: cluster-autoscaler }
subjects: [{ kind: ServiceAccount, name: cluster-autoscaler, namespace: kube-system }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: cluster-autoscaler-aws, namespace: kube-system, labels: { app: cluster-autoscaler-aws } }
spec:
  replicas: 1
  selector: { matchLabels: { app: cluster-autoscaler-aws } }
  template:
    metadata: { labels: { app: cluster-autoscaler-aws } }
    spec:
      serviceAccountName: cluster-autoscaler
      priorityClassName: system-cluster-critical
      nodeSelector: { node-role.kubernetes.io/control-plane: "true" }
      tolerations: [{ key: CriticalAddonsOnly, operator: Exists }]
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:$ca_version
          resources: { requests: { cpu: 50m, memory: 200Mi }, limits: { memory: 400Mi } }
          env: [{ name: AWS_REGION, value: "$(val AWS_REGION)" }]
          command:
            - ./cluster-autoscaler
            - --cloud-provider=aws
            - --leader-elect-resource-name=cluster-autoscaler-aws
            - --status-config-map-name=cluster-autoscaler-status-aws
$(nodes_flags "$(val AWS_WORKER_GROUPS)")
            - --scan-interval=10s
            - --scale-down-unneeded-time=2m
            - --scale-down-delay-after-add=2m
            # A node that joined before its pod was placed is otherwise rechecked only after 5 minutes.
            - --unremovable-node-recheck-timeout=1m
            - --skip-nodes-with-local-storage=false
            - --v=2
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: cluster-autoscaler-azure, namespace: kube-system, labels: { app: cluster-autoscaler-azure } }
spec:
  replicas: 1
  selector: { matchLabels: { app: cluster-autoscaler-azure } }
  template:
    metadata: { labels: { app: cluster-autoscaler-azure } }
    spec:
      serviceAccountName: cluster-autoscaler
      priorityClassName: system-cluster-critical
      nodeSelector: { node-role.kubernetes.io/control-plane: "true" }
      tolerations: [{ key: CriticalAddonsOnly, operator: Exists }]
      volumes: [{ name: azure, secret: { secretName: cluster-autoscaler-azure, items: [{ key: cert.pem, path: cert.pem }] } }]
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:$ca_version
          resources: { requests: { cpu: 50m, memory: 200Mi }, limits: { memory: 400Mi } }
          volumeMounts: [{ name: azure, mountPath: /etc/azure, readOnly: true }]
          env:
            - { name: ARM_CLIENT_ID, valueFrom: { secretKeyRef: { name: cluster-autoscaler-azure, key: ClientID } } }
            - { name: ARM_TENANT_ID, valueFrom: { secretKeyRef: { name: cluster-autoscaler-azure, key: TenantID } } }
            - { name: ARM_SUBSCRIPTION_ID, valueFrom: { secretKeyRef: { name: cluster-autoscaler-azure, key: SubscriptionID } } }
            - { name: ARM_RESOURCE_GROUP, valueFrom: { secretKeyRef: { name: cluster-autoscaler-azure, key: ResourceGroup } } }
            - { name: ARM_CLIENT_CERT_PATH, value: /etc/azure/cert.pem }
            - { name: ARM_VM_TYPE, value: vmss }
          command:
            - ./cluster-autoscaler
            - --cloud-provider=azure
            - --leader-elect-resource-name=cluster-autoscaler-azure
            - --status-config-map-name=cluster-autoscaler-status-azure
$(nodes_flags "$(val AZURE_WORKER_SCALE_SETS)")
            - --scan-interval=10s
            - --scale-down-unneeded-time=2m
            - --scale-down-delay-after-add=2m
            # A node that joined before its pod was placed is otherwise rechecked only after 5 minutes.
            - --unremovable-node-recheck-timeout=1m
            - --skip-nodes-with-local-storage=false
            - --v=2
EOF

# 4. Stale nodes: with no cloud controller, nothing deletes the Node of an instance the autoscaler
# removed. Delete nodes it marked for deletion once they stop reporting (every 30 s).
sudo tee /usr/local/bin/k3s-node-gc >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
k3s kubectl get nodes -o json | jq -r '.items[]
  | select(any(.spec.taints[]?; .key == "ToBeDeletedByClusterAutoscaler"))
  | select(any(.status.conditions[]?; .type == "Ready" and .status != "True"))
  | .metadata.name' | while read -r node; do
  [[ -n "$node" ]] && { echo "deleting stale node $node"; k3s kubectl delete node "$node" --wait=false; }
done
EOF
sudo chmod 755 /usr/local/bin/k3s-node-gc
command -v jq >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq; }
sudo tee /etc/systemd/system/k3s-node-gc.service >/dev/null <<'EOF'
[Unit]
Description=Delete Kubernetes nodes the Cluster Autoscaler removed
After=k3s.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/k3s-node-gc
EOF
sudo tee /etc/systemd/system/k3s-node-gc.timer >/dev/null <<'EOF'
[Unit]
Description=Stale node cleanup every 30 seconds
[Timer]
OnBootSec=1min
OnUnitActiveSec=30s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now k3s-node-gc.timer >/dev/null

for app in cluster-autoscaler-aws cluster-autoscaler-azure; do
  kubectl -n kube-system rollout status "deployment/$app" --timeout=180s
done
echo "cluster-install: k3s $k3s_version and both autoscalers ready"
