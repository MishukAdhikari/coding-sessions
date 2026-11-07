# Local control socket

The server can also serve its [MCP tools](mcp.md) on a Unix socket, for scripts and agents on the same machine. There is no HTTP, OAuth or token: who can open the socket file decides who can use it. It is off by default.

```bash
# in the instance's environment file, then restart
CS_SOCKET=1                              # at CS_DATA_DIR/cs.sock
# or
CS_SOCKET_PATH=/var/lib/coding-sessions/personal/run/cs.sock
```

On an installed server `CS_DATA_DIR` is `/var/lib/coding-sessions/<instance>/data`, so `CS_SOCKET=1` puts the socket at `/var/lib/coding-sessions/<instance>/data/cs.sock`. Keep a custom path under `/var/lib/coding-sessions/<instance>`: the service can write only there, and its `/tmp` is private to the service, so a socket in `/tmp` is invisible to your shell.

The server creates the socket 0600 in a 0700 folder owned by the service account. It refuses to start when the folder is open to group or others, when the path holds something that is not a socket, or when the path is 100 bytes or longer. A socket file left by a server that was killed is replaced. Nothing listens on TCP.

Read [Security](security.md#local-control-socket) before turning it on: every program running as the service account can then control every Session.

## Protocol

Newline-delimited JSON. Send one request per line:

```json
{"id": 1, "method": "list_sessions", "params": {"include_ended": false}}
```

Each request gets one line back, with the same `id`:

```json
{"id": 1, "result": {"sessions": [], "host": {}}}
{"id": 2, "error": {"code": "tool_error", "message": "No live session m:cs-x. list_sessions shows the live ones."}}
```

`id` can be any JSON value. `params` is optional and must be an object. Several requests can be in flight on one connection, and answers come back in the order they finish.

| Method | What it does |
| --- | --- |
| `ping` | Answers `{"pong": true}`. |
| `methods` | Every method with its description and the JSON Schema of its params. |
| every [MCP tool](mcp.md#tools) | `list_sessions`, `read_session`, `send_message`, `press_keys`, `wait_for_session`, `list_projects`, `list_repos`, `launch_session`, `resume_session`, `end_session`, `agent_accounts`, `agent_auth`, with the same params as the MCP tool. |

The methods run the same code as `/mcp`, with the same checks and limits: `wait_for_session` waits at most 90 seconds per call, and the result is the tool's structured result. A tool's own refusal is `tool_error`.

| Error code | When |
| --- | --- |
| `parse_error` | The line is not JSON. |
| `invalid_request` | Not an object, `method` is not a string, or `params` is not an object. |
| `unknown_method` | Not one of the methods above. |
| `tool_error` | The tool refused; `message` says why. |
| `busy` | More than 8 requests in flight on this connection, 64 on the socket, or 32 open connections. Retry after an answer. |
| `too_large` | A line over 1 MiB. The server answers once and closes that connection. |
| `internal` | The tool failed unexpectedly. |

The service log gets one line per call, such as `control socket: send_message ok 12ms`. It never records params or results.

## Clients

Stay connected until your answers arrive. With Bun 1.3, which the installer uses, the server drops a connection as soon as the client closes its sending side, and answers still being worked on are lost. That matters for slow methods such as `wait_for_session` and `launch_session` with a prompt.

The bundled client sends one request and waits for its answer. On an installed server it runs with the app's own Bun:

```bash
sudo -u cs-personal env CS_SOCKET_PATH=/var/lib/coding-sessions/personal/data/cs.sock \
  /opt/coding-sessions/personal/current/bin/bun \
  /opt/coding-sessions/personal/current/server/socket-client.ts list_sessions

# params as JSON, or "-" to read them from stdin and keep them out of the process list
… socket-client.ts read_session '{"session_id":"m:cs-fix-login","lines":40}'
printf '%s' '{"session_id":"m:cs-fix-login","text":"run the tests"}' | … socket-client.ts send_message -
```

In a checkout with the [`cs` CLI](cli.md), `cs socket` is the same client:

```bash
CS_SOCKET_PATH=/path/to/data/cs.sock cs socket wait_for_session '{"session_id":"m:cs-fix-login"}'
cs socket --socket=/path/to/data/cs.sock methods
```

It prints the result as JSON and exits 0, or prints `code: message` and exits 1.

For raw requests, `socat` keeps the connection open while you type:

```bash
socat READLINE UNIX-CONNECT:/var/lib/coding-sessions/personal/data/cs.sock
{"id":1,"method":"ping"}
{"id":2,"method":"list_sessions"}
```

`nc -U` is fine for methods that answer at once:

```bash
printf '{"id":1,"method":"ping"}\n' | nc -U -q 2 /var/lib/coding-sessions/personal/data/cs.sock
```

`-q 2` is the Ubuntu (`netcat-openbsd`) option to exit two seconds after the input ends. macOS `nc` has no `-q`; use `nc -U` alone there.

## Agents in Sessions

Agents run as the service account, so they can use the socket too. Sessions do not get `CS_SOCKET_PATH` in their environment by default. To pass it on, set it in the instance's environment file and add `CS_PASSTHROUGH_ENV=CS_SOCKET_PATH`. Or tell the agent the path.
