ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# Build arguments for user ID and group ID
ARG USER_ID=1000
ARG USERNAME=glovebox
ARG GO_VERSION=1.23.5
ARG UV_VERSION=0.5.11

# Install dependencies, GitHub CLI, Docker CLI, and Docker daemon (for DinD)
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    git \
    jq \
    sudo \
    ripgrep \
    ca-certificates \
    iptables \
    ipset \
    nftables \
    dnsutils \
    socat \
    procps \
    supervisor \
    gosu \
    inotify-tools \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Go
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then GO_ARCH="amd64"; \
    elif [ "$ARCH" = "arm64" ]; then GO_ARCH="arm64"; \
    else echo "Unsupported architecture: $ARCH" && exit 1; fi && \
    if [ "${GO_VERSION}" = "latest" ]; then \
        ACTUAL_GO_VERSION=$(curl -s 'https://go.dev/VERSION?m=text' | head -1); \
    else \
        ACTUAL_GO_VERSION="go${GO_VERSION}"; \
    fi && \
    curl -fsSL "https://go.dev/dl/${ACTUAL_GO_VERSION}.linux-${GO_ARCH}.tar.gz" -o /tmp/go.tar.gz && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm /tmp/go.tar.gz

# Add Go to PATH
ENV PATH="/usr/local/go/bin:${PATH}"

# Create user with UID matching the host so bind-mounted /workspace is writable.
# GID is auto-assigned (don't pin it to the host GID — Debian reserves low GIDs
# like 20=dialout, causing groupadd to fail silently and useradd to land on the
# wrong group).
# Note: node:*-slim images have a 'node' user at UID/GID 1000; remove it first.
RUN userdel -r node 2>/dev/null || true \
    && groupdel node 2>/dev/null || true \
    && groupadd ${USERNAME} \
    && useradd -m -u ${USER_ID} -g ${USERNAME} -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install UV (Python package manager) as the user using official install script
# This enables 'uv self update' to work inside containers
USER ${USERNAME}
RUN if [ "${UV_VERSION}" = "latest" ]; then \
        curl -LsSf https://astral.sh/uv/install.sh | sh; \
    else \
        curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh; \
    fi

USER root

# Set working directory
WORKDIR /workspace

# Change ownership of workspace (use numeric IDs to avoid group name issues)
RUN chown -R ${USER_ID}:${USERNAME} /workspace

# Add Go, UV, npm global to PATH environment and bash profile
ENV PATH="/home/${USERNAME}/.local/bin:/home/${USERNAME}/.npm-global/bin:/home/${USERNAME}/go/bin:/usr/local/go/bin:${PATH}"
RUN echo 'export PATH="/home/'${USERNAME}'/.local/bin:/home/'${USERNAME}'/.npm-global/bin:/home/'${USERNAME}'/go/bin:/usr/local/go/bin:$PATH"' >> /home/${USERNAME}/.bashrc

# Switch to non-root user
USER ${USERNAME}


# Add version labels for tracking
LABEL org.opencontainers.image.title="glovebox-base"
LABEL org.opencontainers.image.description="Base image for glovebox - AI coding agents"
LABEL tools.git="installed"
LABEL tools.gh="installed"
LABEL tools.ripgrep="installed"
LABEL tools.node="installed"
LABEL tools.go="installed"
LABEL tools.uv="installed"

CMD ["bash"]
