# Helixent Container Deployment

This directory contains the local container deployment files for the Helixent debug agent service.

## Local Compose Test

From the repository root:

```bash
cp deploy/compose/.env.example deploy/compose/.env
docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yaml up --build
```

Open:

```text
http://localhost:3002/internal/debug
```

Check health:

```bash
curl http://localhost:3002/api/health
```

Stop:

```bash
docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yaml down
```

## Notes

- The container listens on `PORT=3001`.
- The local compose file maps `HELIXENT_HOST_PORT`, default `3002`, to container port `3001`.
- `skills/`, `workflows/`, and `.helixent/` are mounted as local volumes for debug-panel editing and archive persistence.
- Session and trace state are in memory and disappear when the container restarts.
