# Helixent Main System Integration

This guide describes how the main system should call Helixent when both services run on the same server.

Helixent exposes two entry points:

- Web debug panel: for humans, protected by username/password login.
- Main system API: for service-to-service calls, protected by bearer API keys.

API details are documented in [`api-contract.md`](./api-contract.md).

## Main System API

The main system should call Helixent with:

```http
Authorization: Bearer <HELIXENT_API_KEY>
```

Example:

```bash
curl -H "Authorization: Bearer main-system-secret" \
  http://helixent:3001/api/v1/agents
```

Use `http://helixent:3001` when the main system and Helixent are on the same Docker network.

Do not use `localhost` from inside the main-system container. Inside a container, `localhost` points to that container itself, not to Helixent.

## Option 1: Same Compose File

Use this when one compose file should manage both services.

Example directory layout:

```text
/opt/rjj-wecom-demo/
├── docker-compose.yaml
├── .env
├── main-system/
└── helixent/
```

Example `docker-compose.yaml`:

```yaml
services:
  main-system:
    image: your-main-system:latest
    container_name: rjj-main-system
    ports:
      - "8080:8080"
    environment:
      NODE_ENV: production
      HELIXENT_BASE_URL: http://helixent:3001
      HELIXENT_API_KEY: ${HELIXENT_API_KEY}
    depends_on:
      - helixent
    restart: unless-stopped

  helixent:
    build:
      context: ./helixent
      dockerfile: deploy/docker/Dockerfile
    image: helixent:local
    container_name: helixent-debug-agent
    ports:
      - "3002:3001"
    environment:
      NODE_ENV: production
      PORT: 3001
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
      DEEPSEEK_BASE_URL: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
      DEEPSEEK_MODEL: ${DEEPSEEK_MODEL:-deepseek-v4-pro}
      HELIXENT_WEB_USERS: ${HELIXENT_WEB_USERS:-}
      HELIXENT_API_KEYS: ${HELIXENT_API_KEY}
    volumes:
      - ./helixent/skills:/app/skills
      - ./helixent/workflows:/app/workflows
      - ./helixent/.helixent:/app/.helixent
    restart: unless-stopped
```

Example `.env`:

```env
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro

HELIXENT_WEB_USERS=
HELIXENT_API_KEY=main-system-secret
```

Start both services:

```bash
docker compose --env-file .env up -d --build
```

Start only Helixent:

```bash
docker compose --env-file .env up -d --build helixent
```

Start only the main system:

```bash
docker compose --env-file .env up -d --build main-system
```

View logs:

```bash
docker compose logs -f helixent
docker compose logs -f main-system
```

## Option 2: Separate Compose Files With A Shared Network

Use this when Helixent and the main system are deployed from separate project directories.

Create a shared Docker network once:

```bash
docker network create rjj-network
```

Helixent compose:

```yaml
services:
  helixent:
    build:
      context: .
      dockerfile: deploy/docker/Dockerfile
    image: helixent:local
    container_name: helixent-debug-agent
    ports:
      - "3002:3001"
    environment:
      NODE_ENV: production
      PORT: 3001
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
      DEEPSEEK_BASE_URL: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
      DEEPSEEK_MODEL: ${DEEPSEEK_MODEL:-deepseek-v4-pro}
      HELIXENT_WEB_USERS: ${HELIXENT_WEB_USERS:-}
      HELIXENT_API_KEYS: ${HELIXENT_API_KEY}
    volumes:
      - ./skills:/app/skills
      - ./workflows:/app/workflows
      - ./.helixent:/app/.helixent
    networks:
      - rjj-network
    restart: unless-stopped

networks:
  rjj-network:
    external: true
```

Main-system compose:

```yaml
services:
  main-system:
    image: your-main-system:latest
    container_name: rjj-main-system
    ports:
      - "8080:8080"
    environment:
      NODE_ENV: production
      HELIXENT_BASE_URL: http://helixent:3001
      HELIXENT_API_KEY: ${HELIXENT_API_KEY}
    networks:
      - rjj-network
    restart: unless-stopped

networks:
  rjj-network:
    external: true
```

Start Helixent from the Helixent project directory:

```bash
docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yaml up -d --build
```

Start the main system from the main-system project directory:

```bash
docker compose --env-file .env up -d --build
```

The main system should call:

```text
http://helixent:3001
```

## Verification

From the server host:

```bash
curl http://localhost:3002/api/health
```

From inside the main-system container:

```bash
curl -H "Authorization: Bearer main-system-secret" \
  http://helixent:3001/api/v1/agents
```

Expected response:

```json
{
  "agents": [
    {
      "type": "gma",
      "name": "GMA",
      "role": "general_manager_assistant",
      "description": "A general manager assistant agent"
    }
  ]
}
```

The web debug panel remains available through the host port:

```text
http://<server-host>:3002/internal/debug
```
