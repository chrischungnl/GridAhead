FROM python:3.12-slim

WORKDIR /app

# Install litestream for SQLite replication
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin && rm /tmp/litestream.tar.gz

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY config.json.example .
COPY litestream.yml /etc/litestream.yml
COPY start.sh .
RUN chmod +x start.sh

EXPOSE 8090

CMD ["./start.sh"]
