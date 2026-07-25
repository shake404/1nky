#!/bin/sh
# ---------------------------------------------------------------------------
# 1NKY — tor container entrypoint
# ---------------------------------------------------------------------------
# Fixes up the hidden-service directory, then drops root and execs tor.
#
# Why this exists: /var/lib/tor/onion is a named volume (tor_keys). On first
# run docker creates it root-owned and 0755, and tor refuses to use a
# HiddenServiceDir it does not own or that is group/world accessible — it exits
# rather than starting with weak permissions on the keys that ARE the address.
# ---------------------------------------------------------------------------
set -eu

mkdir -p /var/lib/tor/onion
chown -R tor:tor /var/lib/tor
chmod 700 /var/lib/tor /var/lib/tor/onion

# Drop to the unprivileged `tor` user for the whole life of the process. Using
# su-exec rather than torrc's `User` directive keeps the privilege boundary in
# one visible place, and tor never holds root at all.
exec su-exec tor:tor "$@"
