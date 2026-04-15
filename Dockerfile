FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    build-essential \
    cmake \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Python TTS
RUN pip3 install --break-system-packages --no-cache-dir gtts

# Node dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Build whisper.cpp + download model
RUN cd node_modules/nodejs-whisper/cpp/whisper.cpp/models && \
    curl -L -o ggml-base.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" && \
    cd .. && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release

# Copy source and build
COPY src/ src/
COPY python/ python/
COPY tsconfig.json ./
RUN npx tsup src/bot.ts --format esm

CMD ["node", "dist/bot.js"]
