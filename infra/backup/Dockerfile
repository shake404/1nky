# ---------------------------------------------------------------------------
# 1NKY — nightly backup runner (handoff item G, Phase 4)
# ---------------------------------------------------------------------------
# busybox crond + backup.sh. Pushes a Postgres dump and a strfry LMDB snapshot
# to the existing S3-compatible bucket every night, then prunes old prefixes.
#
# NO-LOGS: this container accepts no connections, so it cannot log a request.
# backup.sh prints object names and byte counts only, and pipes ALL of its own
# output through an IP-shaped-string filter as defence in depth (a failed
# pg_dump would otherwise print the database container's bridge address).
#
# Version pinning: the `alpine:3.20` tag is the pin. It fixes the whole apk
# index — rclone, GNU coreutils/tar, and postgresql16-client (whose major is in
# the package name, which is the pin that actually matters: pg_dump must be
# >= the server's 16). Moving to a newer Alpine is a deliberate edit here.
# ---------------------------------------------------------------------------
FROM alpine:3.20

# bash          — backup.sh wants `set -o pipefail` + PIPESTATUS + [[ ]]
# coreutils     — GNU `date -d "-14 days"`; busybox date cannot do relative dates
# tar / gzip    — GNU tar for predictable --exclude handling
# rclone        — the S3 client. Configured ENTIRELY from env (see backup.sh):
#                 no rclone.conf is ever written, so no secret lands on disk.
# postgresql16-client — pg_dump / pg_restore
# curl, openssl, ca-certificates — TLS roots for rclone, plus a way to poke the
#                 bucket by hand during a restore drill
RUN apk add --no-cache \
      bash \
      coreutils \
      tar \
      gzip \
      rclone \
      postgresql16-client \
      curl \
      openssl \
      ca-certificates

# Optional: mdb_copy takes a transactionally consistent LMDB snapshot instead of
# tarring a live directory (backup.sh prefers it when present AND the strfry
# volume is mounted read-write — see the tradeoff note in infra/README.md).
# It is not in every Alpine index, and a missing *optional* tool must not break
# the image, so this layer is allowed to fail.
RUN apk add --no-cache lmdb-tools 2>/dev/null \
      || echo "note: lmdb-tools unavailable; backup.sh will tar the LMDB dir"

COPY backup.sh /backup.sh
COPY entrypoint.sh /entrypoint.sh
COPY rclone-env.sh /rclone-env.sh

# Authored on Windows: git records neither the +x bit (core.fileMode=false) nor
# LF endings for us, and a stray CR makes the shebang unrunnable. Normalise.
RUN sed -i 's/\r$//' /backup.sh /entrypoint.sh /rclone-env.sh \
 && chmod 0755 /backup.sh /entrypoint.sh /rclone-env.sh

ENTRYPOINT ["/entrypoint.sh"]

# -l 8 keeps crond's own chatter down; -L /dev/stderr stops crond's errors from
# vanishing into a syslog daemon that does not exist in this image. The backup
# job's own stdout/stderr reach `docker compose logs` because entrypoint.sh puts
# MAILTO="" in the crontab (busybox crond then leaves the child's fds alone
# instead of piping them into a mailer that is not installed either).
CMD ["crond", "-f", "-l", "8", "-L", "/dev/stderr"]
