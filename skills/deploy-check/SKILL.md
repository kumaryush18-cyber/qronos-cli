---
name: deploy-check
description: "Instrument a frontend with version fingerprinting (meta tag + /__version endpoint) so automated testing can verify the correct build is deployed before walking. Use when asked to 'add version check', 'deploy verification', 'instrument version', 'add build fingerprint', 'deploy-check', or verify a deployment."
version: 1.0.0
user_invocable: true
---

# Deploy Check

Instrument a frontend app with subtle version fingerprinting — a `<meta>` tag in the HTML and a `/__version` JSON endpoint — so automated testing can confirm the correct build is deployed before testing begins.

## Usage

```
/deploy-check [--install] [--verify url] [--expected-sha sha]
```

| Parameter | Default | Notes |
|-----------|---------|-------|
| **--install** | Auto-detect | Instrument the current project with version fingerprinting |
| **--verify url** | None | Check a running app and report what version is deployed |
| **--expected-sha sha** | Current HEAD | Fail if the deployed SHA doesn't match |

---

## What Gets Installed

### 1. Meta Tag
A `<meta>` tag injected into the HTML `<head>` at build time:
```html
<meta name="build-version" content="sha:a1b2c3d timestamp:2026-06-08T12:00:00Z" />
```

### 2. Version Endpoint
A `/__version` route returning JSON:
```json
{
  "git_sha": "a1b2c3d",
  "git_branch": "main",
  "build_timestamp": "2026-06-08T12:00:00Z",
  "version": "1.2.3",
  "dirty": false
}
```

### 3. Build-time Script
A `scripts/version-stamp.sh` that generates a `version.json` at build time.
