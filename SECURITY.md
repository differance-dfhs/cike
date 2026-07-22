# Security Policy

## Reporting a vulnerability

Please do not place credentials, private conversations, meeting notes, browser history, project files, or personal paths in a public Issue.

Open a minimal GitHub security advisory with reproducible steps and synthetic data. Include the affected version, expected behavior and observed behavior. Remove tokens and replace private paths with placeholders such as `/Users/demo/Projects/example`.

## Security model

- The renderer receives a bounded snapshot, not raw source payloads.
- Local artifacts are served through an authenticated loopback endpoint.
- Workspace changes require an explicitly configured, validated local root.
- Symlinks, traversal paths, credential-shaped content and untrusted remote writes fail closed.
- External sends, publishing and destructive actions are outside the default autonomous boundary.

This preview is not Apple-notarized. Verify release checksums before installation.
