#!/bin/sh
# ---------------------------------------------------------------------------
# 1NKY — rclone remote `dest:`, synthesised from the existing R2_* variables
# ---------------------------------------------------------------------------
# Two ways to use it, and the second one is why it is a separate file:
#
#   1. Sourced by backup.sh.
#
#   2. As an entrypoint override, so a human doing a restore gets a configured
#      rclone without retyping six environment variables:
#
#        docker compose run --rm --entrypoint /rclone-env.sh backup \
#          rclone lsl dest:1nky-media/backups
#
#        docker compose run --rm --entrypoint /rclone-env.sh backup \
#          sh -c 'rclone lsf --dirs-only dest:$R2_BUCKET/backups/'
#
# NO CONFIG FILE. rclone is driven entirely by RCLONE_CONFIG_<REMOTE>_<KEY>
# variables and RCLONE_CONFIG points at /dev/null, so no credential is ever
# written to a disk — not in the image, not in a volume, not in the repo.
# ---------------------------------------------------------------------------
set -eu

: "${R2_ENDPOINT:?not set}"
: "${R2_ACCESS_KEY_ID:?not set}"
: "${R2_SECRET_ACCESS_KEY:?not set}"

export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_DEST_TYPE=s3
export RCLONE_CONFIG_DEST_PROVIDER="${BACKUP_S3_PROVIDER:-a cloud host}"
export RCLONE_CONFIG_DEST_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_DEST_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
# Backups are never public objects. The bucket already exists (the media service
# owns it), so never attempt a create or a HEAD on it either — that also keeps
# the key's required permissions down to object read/write/delete.
export RCLONE_CONFIG_DEST_ACL=private
export RCLONE_CONFIG_DEST_NO_CHECK_BUCKET=true
# Usually unnecessary: the endpoint carries the region. Set BACKUP_S3_REGION
# only if the provider rejects the signature without it.
if [ -n "${BACKUP_S3_REGION:-}" ]; then
	export RCLONE_CONFIG_DEST_REGION="$BACKUP_S3_REGION"
fi

# Used as an entrypoint -> hand over to the command.
# Sourced -> just leave the exports behind and return.
#
# The $0 test is what distinguishes the two, and it is not decoration: a sourced
# script inherits the CALLER's positional parameters, so a bare `[ $# -gt 0 ]`
# here would make `/backup.sh anything` exec `anything`. When sourced, $0 is
# still the caller's name, so this case never matches.
case "${0##*/}" in
rclone-env.sh)
	[ "$#" -gt 0 ] && exec "$@"
	;;
esac
