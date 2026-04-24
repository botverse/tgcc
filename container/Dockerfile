FROM node:20-slim

# Essentials (git for CC, sudo for the project user, build-essential for native deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git sudo \
    build-essential python3 python3-pip python3-venv \
    procps postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# CC CLI
RUN npm install -g @anthropic-ai/claude-code

# Relay daemon
COPY tgcc-relay.mjs /usr/local/bin/tgcc-relay
RUN chmod +x /usr/local/bin/tgcc-relay

# Socket dir
RUN mkdir -p /run/tgcc

# Non-root user with sudo (for installing deps)
# Reuse the existing node user (UID 1000) — rename to "project" and set up home dir
RUN usermod -l project -d /home/project -m node \
    && groupmod -n project node \
    && echo 'project ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/project
USER project
WORKDIR /home/project

# Relay is the main process
ENTRYPOINT ["node", "/usr/local/bin/tgcc-relay"]
