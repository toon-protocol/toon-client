FROM node:22-bookworm

# Links the published GHCR package (ghcr.io/toon-protocol/toon-client:sandcastle-agent, see the
# pull step in .github/workflows/agent-implement.yml) to this repo.
LABEL org.opencontainers.image.source="https://github.com/toon-protocol/toon-client"

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (run as root, before the USER switch — corepack
# writes shims into a root-owned prefix). Pin matches toon-client's package.json
# `packageManager` field (pnpm@9.12.3, toon-client#425) so the version is
# pre-cached in the image instead of needing a network fetch at container start.
#
# NO native-build toolchain (python/make/g++) is installed on purpose:
# toon-client's one native dependency (better-sqlite3) is listed in
# `pnpm.neverBuiltDependencies`, so `pnpm install` never compiles it, and every
# other heavy dep (lightningcss, bufferutil, utf-8-validate, esbuild) ships
# prebuilt binaries. Add build-essential here only if a future dependency
# actually needs to compile.
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Matt Pocock's skills, the same plugin used interactively. The runner starts each agent
# session with `/mattpocock-skills:implement` or `/mattpocock-skills:code-review`, so they
# must be installed here. A fresh install doesn't know the official marketplace yet, so add
# it first. This takes the plugin's latest release when the image is built; rebuild the
# image to pick up a newer one.
RUN /home/agent/.local/bin/claude plugin marketplace add anthropics/claude-plugins-official \
  && /home/agent/.local/bin/claude plugin install mattpocock-skills@claude-plugins-official

# Foundry provides `anvil` and `cast`, the EVM half of ci.yml's `batch-settlement-exit` job. Pinned to the v1.7.1 that job installs, so an agent
# runs the anvil this client's EVM code was verified against.
RUN curl -fsSL https://foundry.paradigm.xyz | bash \
  && /home/agent/.foundry/bin/foundryup --install v1.7.1

# NO Solana CLI, deliberately. ci.yml's `batch-settlement-exit` job needs `solana-test-validator`
# v3.1.12: infra builds `payment_channels.so` with it, and on a v2.1 validator a sponsored `open`
# leaves the channel account short of rent (`InsufficientFundsForRent`), so v2.1.21 would not
# help. But v3's validator panics in this sandbox with `assertion failed: io_uring_supported()`,
# because the container runtime blocks io_uring (recorded in connector's .sandcastle/Dockerfile).
# So that job is CI-only and is not part of the runner's gate. Foundry stays for the EVM half.

# Add Claude and foundry to PATH
ENV PATH="/home/agent/.local/bin:/home/agent/.foundry/bin:$PATH"

# ENV PATH covers the engine, which execs non-login shells. claude-code spawns its own shells
# for the agent's commands, and a LOGIN shell sources /etc/profile, which rebuilds PATH from
# scratch and drops anything set only via ENV. Export foundry from ~/.profile and ~/.bashrc too.
RUN printf '\n# Foundry (anvil/cast) - see .sandcastle/Dockerfile\nexport PATH="$HOME/.foundry/bin:$PATH"\n' \
  | tee -a /home/agent/.profile >> /home/agent/.bashrc

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
