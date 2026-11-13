# The assistant: the chat front door to the generated application and the
# reporting platform. Built for its URL prefix; see vite.config.ts.
FROM oven/bun:1.4.4 AS build
WORKDIR /srv
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
ARG CHAT_BASE_PATH=/chat
ENV CHAT_BASE_PATH=${CHAT_BASE_PATH}
RUN bun run build

FROM oven/bun:1.4.4
WORKDIR /srv
ENV NODE_ENV=production \
    PORT=4200 \
    # Open-source CopilotKit only: nothing is sent to CopilotKit.
    COPILOTKIT_TELEMETRY_DISABLED=true
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/dist ./dist
COPY --from=build /srv/src ./src
COPY --from=build /srv/server.ts /srv/package.json ./
ARG CHAT_BASE_PATH=/chat
ENV CHAT_BASE_PATH=${CHAT_BASE_PATH}
EXPOSE 4200
HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:4200' + (process.env.CHAT_BASE_PATH ?? '/chat') + '/healthz'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "server.ts"]
