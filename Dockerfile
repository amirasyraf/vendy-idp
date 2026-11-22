# Host-build deployment: deploy/build.sh creates the skeleton and bundle first.
FROM node:24-trixie-slim
ENV PYTHON=/usr/bin/python3 NODE_ENV=production NODE_OPTIONS=--no-node-snapshot
ENV MAKEFLAGS=-j2 CARGO_BUILD_JOBS=2 npm_config_jobs=2
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 g++ make libsqlite3-dev openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /app
COPY --chown=node:node .yarn/releases .yarn/releases
COPY --chown=node:node .yarnrc.yml package.json yarn.lock backstage.json ./
COPY --chown=node:node packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz \
    && node .yarn/releases/yarn-4.13.0.cjs workspaces focus --all --production \
    && node .yarn/releases/yarn-4.13.0.cjs cache clean
COPY --chown=node:node packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz
COPY --chown=node:node app-config.yaml app-config.production.yaml ./
COPY --chown=node:node catalog ./catalog
COPY --chown=node:node deploy/docker-compose.yml deploy/Caddyfile deploy/cluster-install.sh ./deploy/
LABEL com.compute-factory.artifact="idp"
EXPOSE 7007
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
