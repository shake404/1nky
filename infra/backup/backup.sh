#!/usr/bin/env bash
# =============================================================================
# 1NKY — nightly backup (handoff item G)
# =============================================================================
#
# Three artifacts per night, streamed straight to the existing S3-compatible
# bucket under <prefix>/YYYY-MM-DD/ :
#
#   postgres-YYYY-MM-DD.dump      pg_dump custom format, gzip level 9
#   strfry-lmdb-YYYY-MM-DD.tar.gz the relay's LMDB directory
#   tor-keys-YYYY-MM-DD.tar.gz    the hidden-service keypair (the .onion
#                                 address itself — unregenerable)
#
# Then prefixes older than BACKUP_RETAIN_DAYS are purged.
#
# The relay is the source of truth and Postgres is a rebuildable cache, so the
# LMDB snapshot is the one that actually matters. Restore procedure, in order,
# lives in NEXT-STEPS.md — read it before you need it.
#
# WHAT THIS PRINTS: object names, byte counts, purged prefixes. Nothing else.
# Every line goes through `sanitize` before it reaches stdout, so even an
# unexpected error message cannot put something IP-shaped in `docker logs`
# (CLAUDE.md hard rule #1). Credentials are never echoed: they only ever leave
# this script inside rclone's own environment.
#
# Manual run (this is also the restore-drill starting point):
#     docker compose run --rm backup /backup.sh
# =============================================================================
set -euo pipefail

# --- config (all from env; no new secrets, R2_* are the existing ones) -------
DATE="$(date -u +%F)"
PREFIX="${BACKUP_PREFIX:-backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
STRFRY_DB_DIR="${STRFRY_DB_DIR:-/strfry-db}"
STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/1nky-backup}"

# `:?` aborts with the variable NAME only — never a value.
: "${DATABASE_URL:?not set}"
: "${R2_BUCKET:?not set}"

# --- rclone, configured entirely from the environment -----------------------
# Defines the `dest:` remote from R2_ENDPOINT / R2_ACCESS_KEY_ID /
# R2_SECRET_ACCESS_KEY (and validates that they are set). No rclone.conf is
# written or read, so no credential touches a disk. It is a separate file
# because a human doing a restore needs the same remote:
#     docker compose run --rm --entrypoint /rclone-env.sh backup \
#       rclone lsl dest:1nky-media/backups
# shellcheck source=rclone-env.sh
. /rclone-env.sh

# --stats 0 and --log-level ERROR keep rclone silent unless something breaks:
# its progress output names every object and we do not need it twice.
rc_() { rclone --log-level ERROR --stats 0 "$@"; }

# Strip anything shaped like an IPv4 address from our own output. Belt and
# braces: pg_dump's connection errors quote the server's container address, and
# an audit grep over `docker compose logs` must come back empty.
sanitize() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/[ip redacted]/g'; }

# Scratch dir, and its cleanup. WORK is deliberately NOT a `local` inside main:
# the EXIT trap fires after the function has returned, when a function-local
# would already be out of scope — and under `set -u` that turns a clean failure
# into a confusing "work: unbound variable" that masks the real error.
WORK=""
cleanup() {
	[[ -n "$WORK" ]] && rm -rf "$WORK"
	return 0
}

# ---------------------------------------------------------------------------
# Stream one artifact to the bucket.
#
#   upload_stream <object-name> <command...>
#
# The command's stdout is the object body. Nothing is staged on the droplet's
# disk — that box is a 2GB/50GB $6 droplet and the LMDB only grows.
#
# The object lands as `.incoming-<name>` and is renamed (a server-side copy)
# only once the producer exited 0, so a final object name never refers to a
# truncated stream — exactly the guarantee you want the night before a restore.
# `set -o pipefail` is what makes the producer's failure the pipeline's failure;
# rcat itself would happily return 0 on a short read.
# ---------------------------------------------------------------------------
upload_stream() {
	local name="$1"
	shift
	local tmp="dest:${R2_BUCKET}/${PREFIX}/${DATE}/.incoming-${name}"
	local final="dest:${R2_BUCKET}/${PREFIX}/${DATE}/${name}"

	"$@" | rc_ rcat "$tmp"
	rc_ moveto "$tmp" "$final"
	echo "uploaded ${PREFIX}/${DATE}/${name}"
}

main() {
	WORK="$(mktemp -d /tmp/1nky-backup.XXXXXX)"
	mkdir -p "$STATE_DIR"
	# This function runs in a subshell (it is the left side of a pipeline), so
	# the trap is scoped to it and fires however it exits.
	trap cleanup EXIT

	echo "backup ${DATE} start"

	# --- 1. Postgres -------------------------------------------------------
	# Custom format is the restorable one: pg_restore can then rebuild into a
	# fresh database, reorder, or restore a single table. -Z9 is the gzip.
	# --no-owner/--no-privileges so a restore does not depend on the role
	# layout of the box it came from.
	upload_stream "postgres-${DATE}.dump" \
		pg_dump --dbname="$DATABASE_URL" \
		--format=custom --compress=9 \
		--no-owner --no-privileges

	# --- 2. strfry LMDB ----------------------------------------------------
	# TRADEOFF (documented at length in infra/README.md):
	#
	#   mdb_copy takes the snapshot inside a read transaction, so the copy is a
	#   consistent point in time. It needs to open the LMDB environment, which
	#   means touching lock.mdb — impossible on the read-only mount this service
	#   uses by default. So it is used only when the operator has deliberately
	#   flipped that mount to read-write.
	#
	#   Otherwise we tar the live directory. LMDB's two-meta-page design means
	#   such a copy normally still opens at the last committed transaction, but
	#   "normally" is not "always": a write landing mid-read can tear it. The
	#   fully consistent, format-independent alternative is the relay's own
	#   `strfry export` (JSONL), which cannot be run from here without handing
	#   this container the docker socket — a far worse trade. Run it by hand
	#   before anything risky; NEXT-STEPS.md has the command.
	#
	# lock.mdb is excluded: it is rebuilt on open and copying it is actively
	# unhelpful.
	local src="$STRFRY_DB_DIR"
	if command -v mdb_copy >/dev/null 2>&1 && [[ -w "$STRFRY_DB_DIR" ]]; then
		mkdir -p "$WORK/lmdb"
		# A failed snapshot must not become a missing backup: degrade to the
		# tar path and say so, loudly, rather than aborting the night's run.
		if mdb_copy "$STRFRY_DB_DIR" "$WORK/lmdb"; then
			echo "lmdb snapshot via mdb_copy (consistent)"
			src="$WORK/lmdb"
		else
			echo "WARNING mdb_copy failed; falling back to tar of the live dir"
			rm -rf "$WORK/lmdb"
		fi
	else
		echo "lmdb snapshot via tar of the live dir"
	fi
	upload_stream "strfry-lmdb-${DATE}.tar.gz" \
		tar -czf - -C "$src" --exclude=lock.mdb .

	# --- 2b. onion keys ------------------------------------------------------
	# The hidden-service keypair IS the published .onion address; it cannot be
	# regenerated, only replaced with a different address. A few hundred bytes
	# guarded so a deployment without the tor profile still backs up cleanly.
	if [[ -d /tor-keys ]] && [[ -n "$(ls -A /tor-keys 2>/dev/null)" ]]; then
		upload_stream "tor-keys-${DATE}.tar.gz" \
			tar -czf - -C /tor-keys .
	else
		echo "tor-keys: not mounted or empty, skipped"
	fi

	# --- 3. verify + report ------------------------------------------------
	# Read the sizes back from the bucket rather than from local files: that
	# proves the objects are actually there, which a local stat does not.
	local summary count bytes
	summary="$(rc_ size --json "dest:${R2_BUCKET}/${PREFIX}/${DATE}")"
	count="$(printf '%s' "$summary" | sed -E 's/.*"count":([0-9]+).*/\1/')"
	bytes="$(printf '%s' "$summary" | sed -E 's/.*"bytes":([0-9]+).*/\1/')"

	# --- 4. retention ------------------------------------------------------
	# Date-named prefixes sort lexically, so a string compare against the
	# cutoff is the whole comparison. Anything not shaped like YYYY-MM-DD is
	# left alone — this loop must never be the reason something unexpected
	# disappears from the bucket.
	local cutoff dir
	cutoff="$(date -u -d "-${RETAIN_DAYS} days" +%F)"
	while IFS= read -r dir; do
		dir="${dir%/}"
		[[ "$dir" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
		if [[ "$dir" < "$cutoff" ]]; then
			rc_ purge "dest:${R2_BUCKET}/${PREFIX}/${dir}"
			echo "purged ${PREFIX}/${dir} (older than ${RETAIN_DAYS}d)"
		fi
	done < <(rc_ lsf --dirs-only "dest:${R2_BUCKET}/${PREFIX}/" || true)

	printf 'last_result=ok date=%s objects=%s bytes=%s\n' \
		"$DATE" "$count" "$bytes" >"$STATE_DIR/status"
	echo "backup ${DATE} ok (${count} objects, ${bytes} bytes)"
}

# Failure reporting lives in an EXIT trap rather than after the pipeline, and
# that is not a style choice: with `set -e` a failing pipeline exits the script
# immediately, so anything written after it never runs. The obvious workarounds
# (`if ! main | sanitize` / `main | sanitize || rc=$?`) put main in a context
# where -e is ignored — and bash then ignores it for everything *inside* main
# too, which would silently turn every fail-fast step into a continue.
#
# A non-zero status here means the night's artifacts are incomplete. The day's
# prefix may hold an `.incoming-*` fragment; the next run overwrites it and
# retention eventually drops the prefix. There is never a half-written object
# under a final object name — see upload_stream.
report() {
	local rc=$?
	if [[ "$rc" -ne 0 ]]; then
		printf 'last_result=FAIL date=%s rc=%s\n' "$DATE" "$rc" >"$STATE_DIR/status" || true
		echo "backup ${DATE} FAILED rc=${rc}"
	fi
}
trap report EXIT

# pipefail is what makes main's failure the pipeline's failure: `sanitize` on
# the right-hand side exits 0 regardless.
main 2>&1 | sanitize
