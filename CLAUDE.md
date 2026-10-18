# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

- **Users are the MCP servers** (`substack-reader-mcp`, `medium-reader-mcp`, `spotify-discovery-mcp`), which each pass a prefix to `paceFromEnv`. Keep the variable names the same for all of them; that's the point of the package.
- **No dependencies, and nothing service-specific.** A known API limit (Deezer's 50 per 5 s) belongs in the server that calls it, as a `hosts` entry.
- **Defaults must keep a server's old behavior.** Changing a default here changes every server's pacing on its next release.
- **The last response is returned, not thrown, when retries run out.** Servers map statuses to their own messages (auth errors, "not found"); only an over-long `Retry-After` throws (`RateLimitedError`).
- Tests use a fake clock whose `sleep` advances time, so they assert exact start times.
- Publishing needs the user's npm approval (`--auth-type=web` or `--otp`); Claude Code's permission check blocks publishing from the agent.
