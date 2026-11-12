# Coding Sessions in a container. The app code is root-owned and read-only to the
# unprivileged `cs` account; everything that changes lives in the /home/cs volume.
FROM node:22-bookworm-slim AS node

FROM oven/bun:1.3.14-debian
ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh openssh-client rsync screen procps lsof tini less unzip \
 && rm -rf /var/lib/apt/lists/*

# ttyd (the web terminal) is not packaged in Debian bookworm: use the pinned upstream build.
ARG TTYD_VERSION=1.7.7
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) file=ttyd.x86_64;  sum=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;; \
      arm64) file=ttyd.aarch64; sum=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --proto '=https' --tlsv1.2 -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${file}"; \
    echo "${sum}  /usr/local/bin/ttyd" | sha256sum --check --status; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

# Node.js 22 for the Codex and Command Code CLIs, which install from npm.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

RUN useradd --create-home --home-dir /home/cs --shell /bin/bash --uid 10001 --user-group cs

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY deploy/install-provider-clis deploy/update-coding-clis ./deploy/
COPY docker/entrypoint.sh ./docker/entrypoint.sh
COPY LICENSE README.md SECURITY.md THIRD_PARTY_NOTICES.md ./
RUN chmod 0755 docker/entrypoint.sh deploy/install-provider-clis deploy/update-coding-clis \
 && ln -s /app/deploy/install-provider-clis /usr/local/bin/install-provider-clis \
 && chmod -R a+rX,go-w /app

ENV HOME=/home/cs \
    PATH=/home/cs/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PORT=9121 \
    CS_LISTEN_HOST=0.0.0.0 \
    CS_DATA_DIR=/home/cs/data \
    CS_RUNTIME_DIR=/home/cs/run \
    SCREENDIR=/home/cs/run/screen \
    CS_MUX=screen \
    CS_CHILD_ENV=filtered \
    CS_AGENT_PERMISSIONS=standard

# The entrypoint starts as root only to fix the volume's ownership (PUID/PGID), then runs
# everything as cs. HOME stays /home/cs for both.
VOLUME ["/home/cs"]
EXPOSE 9121
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent --max-time 4 --output /dev/null http://127.0.0.1:9121/ || exit 1
# tini reaps the agents' child processes and forwards stop signals.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
