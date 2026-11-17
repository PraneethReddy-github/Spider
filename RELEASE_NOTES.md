## Spider desktop

Spider maps how a codebase is connected: files, classes, calls, endpoints, datastores and cross-service HTTP calls,
shown as an interactive map. Everything runs on your machine; the code you analyse never leaves it.

### Download

| Platform | File | Updates itself |
|----------|------|----------------|
| Windows | `Spider-Setup-<version>.exe` (installer) | Yes |
| Windows | `Spider-Portable-<version>.exe` (no install) | No |
| Linux | `Spider-<version>-x86_64.AppImage` (`chmod +x`, then run) | Yes |
| Linux (Debian/Ubuntu) | `Spider_<version>_amd64.deb` (`sudo apt install ./Spider_*.deb`) | No (install the new .deb) |

Installed apps check GitHub for a new version on start and every 6 hours, and from **Help → Check for updates…**.

### Requirements

- `git` on your `PATH` to analyse GitHub URLs (local folders work without it).
- Optional model features (Ask Spider, summaries): set `SPIDER_LLM_PROVIDER` and an API key before starting Spider.

Builds are not code-signed yet: Windows SmartScreen may warn on first run ("More info → Run anyway").
