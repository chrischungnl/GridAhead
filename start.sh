#!/bin/sh
# Restore the SQLite DB from Litestream replica, then start the API
# with Litestream running in the background to keep it updated.

set -e

# Restore DB from replica (if it exists)
if [ -n "$LITESTREAM_REPLICA_URL" ]; then
    echo "Restoring database from Litestream replica..."
    litestream restore -if-replica-exists -config /etc/litestream.yml /data/predictions.db
    echo "Database restored ($(du -h /data/predictions.db 2>/dev/null | cut -f1) )"
fi

# Start the API with gunicorn
exec gunicorn app:app \
    --bind 0.0.0.0:${PORT:-8090} \
    --workers 1 \
    --timeout 30 \
    --access-logfile -
