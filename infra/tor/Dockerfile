# ---------------------------------------------------------------------------
# 1NKY — Tor onion mirror (handoff item F, Phase 4)
# ---------------------------------------------------------------------------
# A v3 onion service in front of caddy's plain :8080 vhost. Nothing else.
# This container is not a relay, not an exit, and not a SOCKS proxy — see torrc.
#
# NO-LOGS: `Log notice stderr` in torrc, and nothing here installs a logger,
# a log shipper, or a syslog daemon. See infra/README.md "No-logs posture".
#
# Version pinning: the `alpine:3.20` tag below is the real pin — it fixes the
# whole apk index. The `=~0.4.9` fuzzy constraint on top of it means a patch
# bump inside the series still builds (Alpine backports tor security fixes into
# a release branch), while a jump to a new minor has to be a deliberate edit to
# this file rather than something that arrives silently on a rebuild.
# If a rebuild ever fails with `breaks: world[tor~0.4.9]`, Alpine has moved the
# series: read the version in the error, check the tor changelog, bump here.
# ---------------------------------------------------------------------------
FROM alpine:3.20

# su-exec is the privilege drop (see entrypoint.sh); tini is not needed because
# tor handles SIGTERM itself and reaps nothing.
RUN apk add --no-cache \
      "tor=~0.4.9" \
      su-exec \
 && mkdir -p /var/lib/tor/onion \
 && chown -R tor:tor /var/lib/tor \
 && chmod 700 /var/lib/tor /var/lib/tor/onion

COPY torrc /etc/tor/torrc
COPY entrypoint.sh /entrypoint.sh

# This repo is authored on Windows. git does not record the +x bit here
# (core.fileMode=false) and a stray CR would make the shebang unrunnable, so
# normalise both at build time instead of trusting the checkout.
RUN sed -i 's/\r$//' /entrypoint.sh \
 && chmod 0755 /entrypoint.sh \
 && chown root:root /etc/tor/torrc \
 && chmod 0644 /etc/tor/torrc

ENTRYPOINT ["/entrypoint.sh"]
CMD ["tor", "-f", "/etc/tor/torrc"]
