---
"@oai404iao/pi-code-mode": patch
---

Pin the official Codex 0.157.1 static musl Host instead of the local V8 backport
build, removing the Host's glibc/OpenSSL requirement while retaining binary
integrity and systemd/cgroup enforcement. Keep real policy cleanup in invocation
settlement and exclusive scheduling after abort/timeout, and fail closed on
unsettled effects from preflight, policies and approvals.
