FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/smashup-python
RUN /opt/smashup-python/bin/pip install --no-cache-dir --upgrade pip setuptools wheel
RUN /opt/smashup-python/bin/pip install \
    --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.8.0+cpu
RUN /opt/smashup-python/bin/pip install --no-cache-dir numpy==2.0.2
RUN /opt/smashup-python/bin/python -c \
    "import numpy, torch; print(f'NumPy {numpy.__version__}; PyTorch {torch.__version__}')"

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --omit=dev --prefix backend

COPY backend/ ./backend/
COPY python/ ./python/
COPY shared/ ./shared/
COPY training-data/checkpoints/reinforce.pt ./training-data/checkpoints/reinforce.pt
COPY --from=frontend-build /app/frontend/dist ./frontend/dist/

ENV NODE_ENV=production
ENV SMASHUP_PYTHON_BIN=/opt/smashup-python/bin/python
ENV SMASHUP_RL_CHECKPOINT=/app/training-data/checkpoints/reinforce.pt

EXPOSE 10000

CMD ["npm", "start", "--prefix", "backend"]
