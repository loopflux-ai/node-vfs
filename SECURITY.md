# Security Policy

node-vfs is a sandboxing layer — security is the core of the project. We take vulnerabilities seriously and ask the same of the community.

## Reporting a Vulnerability

**Do not open a public issue for security bugs.** Please report privately so we can fix the issue before it is disclosed.

Preferred channel: [GitHub Private Vulnerability Reporting](https://github.com/loopflux-ai/node-vfs/security/advisories/new) (Security tab → "Report a vulnerability").

If you cannot use the private reporting tool, email the maintainers at `381740310@qq.com` and include:

- Affected package and version (`@loopflux/node-vfs`, `-toolkit`, or adapter)
- Affected operations and config (e.g. `virtualMode`, `execute` allow-list, middleware)
- A description of the impact and a minimal reproduction

## Scope

The following are in scope and **always welcome**:

- Sandbox escape: path traversal, symlink escape, `rootDir` boundary bypass
- Execute guard bypass: allow-list evasion, unsafe env leakage (`LD_PRELOAD`, `ComSpec`, etc.)
- Policy/quota bypass: deny-list filtering gaps, quota accounting errors
- Cache correctness leading to cross-tenant data exposure or stale permission states

Out of scope (known, documented limits):

- Arbitrary code execution when an allowed command is itself arbitrary (`node script.js`) — the execute allow-list constrains command *shape*, not the code they run. Adversarial isolation requires a container or sandboxed user.

## Response Commitment

| Triage | Timeline (business days) |
|---|---|
| Initial acknowledgement | 3 |
| Severity assessment | 5 |
| Fix for critical/high | 14 |
| Public disclosure (after fix) | Coordinated, typically 30 days after release |

We release security fixes as quickly as possible and coordinate disclosure with reporters.
