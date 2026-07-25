#!/bin/sh
# ---------------------------------------------------------------------------
# 1NKY — backup container entrypoint
# ---------------------------------------------------------------------------
# Writes the crontab from $BACKUP_CRON, snapshots the runtime environment for
# cron's children, then execs whatever CMD asked for (crond, normally).
#
# It also runs for the one-shot path, which is the point:
#     docker compose run --rm backup /backup.sh
# ...gets the same environment handling and then just runs the script.
# ---------------------------------------------------------------------------
set -eu

: "${BACKUP_CRON:=10 9 * * *}"
: "${BACKUP_STATE_DIR:=/var/lib/1nky-backup}"

umask 077
mkdir -p "$BACKUP_STATE_DIR"

# --- environment for cron children -----------------------------------------
# busybox crond does pass its own environ through to jobs, unlike vixie cron,
# but "the nightly job silently lost its credentials" is a failure you would
# discover during a restore. So make it explicit rather than a behaviour we rely
# on. 0600, inside the container only, holding the same values already visible
# in /proc/1/environ — no new exposure.
esc() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }

{
	echo "# generated at container start by entrypoint.sh — not in any image layer"
	for v in DATABASE_URL \
		R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET \
		BACKUP_S3_PROVIDER BACKUP_S3_REGION \
		BACKUP_PREFIX BACKUP_RETAIN_DAYS BACKUP_STATE_DIR \
		STRFRY_DB_DIR; do
		eval "val=\${$v-}"
		[ -n "${val}" ] || continue
		printf "export %s='%s'\n" "$v" "$(esc "$val")"
	done
} >/etc/backup.env
chmod 600 /etc/backup.env

# --- crontab ---------------------------------------------------------------
# Both halves of this are load-bearing, and both were found the hard way.
#
# `MAILTO=` with NO quotes. busybox crond does not strip quotes from the value,
# so `MAILTO=""` sets the mail recipient to a two-character name instead of
# disabling mail — it then pipes every job's output into `sendmail -ti`, which
# this image does not have. Observed result: the backup's output vanished and
# the container logged `sendmail: can't connect to remote host (127.0.0.1)`,
# which is both a lost audit trail AND an IP address in a log line.
#
# The explicit redirect to PID 1's stdout/stderr (crond is PID 1 here, so those
# are the container's) is the belt to that braces: it puts the run in
# `docker compose logs backup` and leaves crond's mail file empty, and busybox
# only invokes the mailer when the job actually wrote something to that file.
# Do not remove one on the grounds that the other covers it.
#
# Times are UTC — nothing in this image sets a timezone, on purpose.
{
	echo 'MAILTO='
	echo "$BACKUP_CRON . /etc/backup.env; /backup.sh >/proc/1/fd/1 2>/proc/1/fd/2"
} >/etc/crontabs/root
chmod 600 /etc/crontabs/root

echo "backup service ready — schedule '$BACKUP_CRON' UTC, retention ${BACKUP_RETAIN_DAYS:-14}d"

exec "$@"
