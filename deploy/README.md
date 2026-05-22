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

The web panel requires a login. The default account is:

```text
admin / admin
```

Add more users in `deploy/compose/.env`:

```env
HELIXENT_WEB_USERS=alice:alice-password,bob:bob-password
```

Main-system `/api/v1/*` calls use bearer API keys instead of the web login:

```env
HELIXENT_API_KEYS=main-system-secret
```

Example:

```bash
curl -H "Authorization: Bearer main-system-secret" http://localhost:3002/api/v1/agents
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
