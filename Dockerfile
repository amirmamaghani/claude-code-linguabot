FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    espeak-ng \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Python venv for TTS
RUN python3 -m venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"
RUN pip install --no-cache-dir \
    "kokoro>=0.9.4" \
    "misaki[en,es,fr,ja,zh,hi,it,pt]" \
    soundfile numpy gtts

# Pre-download Kokoro model
RUN python3 -c "from kokoro import KPipeline; KPipeline(lang_code='a')"

# Node dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Pre-download Whisper model
RUN npx nodejs-whisper download --model base

# Copy source and build
COPY . .
RUN npm run build

CMD ["npm", "start"]
