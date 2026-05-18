FROM oven/bun:1.3.14-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY index.ts ./
COPY src ./src
COPY skills ./skills
COPY workflows ./workflows
COPY goldai.md ./goldai.md

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? '3001') + '/api/health'); if (!r.ok) process.exit(1)"

CMD ["bun", "run", "src/server/index.ts"]
