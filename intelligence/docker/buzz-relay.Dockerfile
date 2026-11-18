# syntax=docker/dockerfile:1.7
#
# The Buzz relay that the Intelligence interface's Buzz provider keeps threads, run history and
# memory on (intelligence/intelligence.md). Built from the pinned checkout, deps.json `buzz`, which
# compose passes as the additional build context `buzz`.
#
# Ours, not upstream's Dockerfile: that one also builds Buzz's web bundles with pnpm, and this
# repository uses Bun and nothing else. The relay is one Rust crate, and its migrations are compiled
# into the binary (`sqlx::migrate!`), so cargo is all it needs. Rust is the version the checkout's
# rust-toolchain.toml pins.

ARG RUST_VERSION=1.98.1

FROM rust:${RUST_VERSION}-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake pkg-config libssl-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY --from=buzz . .
RUN cargo build --release --locked -p buzz-relay --bin buzz-relay \
    && strip target/release/buzz-relay

FROM debian:bookworm-slim
# git: the relay shells out to it for its (unused here) repository hosting, and checks it is present.
# postgresql-client: the entrypoint creates the relay's database when a volume predates it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git postgresql-client curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /var/lib/buzz --create-home buzz
COPY --from=build /build/target/release/buzz-relay /usr/local/bin/buzz-relay
COPY --chmod=0755 buzz-relay-entrypoint.sh /usr/local/bin/buzz-relay-entrypoint
USER buzz
WORKDIR /var/lib/buzz
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/usr/local/bin/buzz-relay-entrypoint"]
