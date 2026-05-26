FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV CHESS_TRAINER_HOST=0.0.0.0
ENV PORT=8000
ENV CHESS_TRAINER_DATA_DIR=/data

COPY . /app

RUN mkdir -p /data

EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os, urllib.request; port = os.environ.get('PORT', '8000'); urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=3)"

CMD ["python3", "serve.py"]
