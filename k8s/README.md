# K8s Manifests — REFERENCE ONLY

These YAML files are **documentation** — NOT applied automatically by CI.

Deployment config (env, resources, probes, ingress) is managed directly on the
**Rancher UI**. CI (Jenkins) only runs `kubectl set image` to update the container image.

This is an **internal, VPN-only** tool (Next.js standalone). It mints JWTs and holds
API keys entered in the UI — **never expose it publicly**.

## Image

```
<your-registry>/ci/omicx-local-all-in-one:latest
```

Build & push (first deploy, by hand):

```bash
cd omicx-local-all-in-one
docker build -t <your-registry>/ci/omicx-local-all-in-one:latest .
docker login <your-registry>
docker push  <your-registry>/ci/omicx-local-all-in-one:latest
```

> If the build env cannot reach Docker Hub, swap the `node:20-alpine` base in the
> `Dockerfile` for the Harbor-mirrored node image (ask ops).

## Setup new environment (one-time, by ops)

1. Create the Deployment on Rancher using `deployment.yaml` as reference:
   - Container `omicx-local-all-in-one`, port **8080**
   - `imagePullSecrets: harbor-registry`
   - Health probe: `GET /api/health`
   - **No** infra Secrets needed (no mongo/kafka/redis) — all creds are entered in the UI.
2. Create the `ClusterIP` Service on port 8080.
3. Configure the **Ingress** as a VPN-only domain (`ingress.yaml` is the template):
   - Pick an internal host, e.g. `omicx-local-all-in-one.<internal-domain>`
   - Point internal DNS at the ingress LB (same target as tool-service)
   - Reuse tool-service's `ingressClassName`, VPN/IP-whitelist annotation, and TLS issuer
   - Confirm these values with ops — do not invent a new mechanism.

## What CI does

```
npm build → docker build → docker push → kubectl set image → rollout status
```

(Only `kubectl set image` touches the live cluster; everything else is managed on Rancher.)

## Config persistence note

`.apitester-config.json` lives inside the container and is **lost on pod restart**.
That is fine — the proxy receives credentials per-request from the browser
(localStorage). To persist server-side config across restarts, mount a **private**
volume and set `APITESTER_CONFIG_PATH` (see the commented env in `deployment.yaml`) —
mind that the file stores **plaintext** credentials.
