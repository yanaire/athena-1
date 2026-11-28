# Athena research extensions

This document describes the executable contract in `runtime/extensions.ts` and
`runtime/external-mcp-client.ts`. It is separate from the earlier research
catalog. That catalog's external package candidates are not install manifests.

## Bundled skill procedures

The host registers the twelve original Athena procedures from catalog commit
`987e61d8b922c609b0fda3794a06f835c9b36530`. Their Markdown bytes are unchanged.
`skills/catalog.json` records names, descriptions, source commit, version, roles,
required capabilities and SHA-256. The runtime pins the catalog file's own hash,
checks each source path and content hash, and archives the accepted package in
its host store. These startup integrity checks read the sources; they do not
place every source in a model prompt.

In chat, `$` lists enabled skills for the coordinator. A sent `$skill-id` or
`$plugin-id/skill-id` loads the pinned procedure into the coordinator’s next
model request and records explicit selection on its attempt. Workers can load
procedures allowed for their role using `load_skill`.

The model receives metadata. `load_skill` loads only its selected procedure and
records the project, conversation, run, task, agent session and attempt,
selection reason, content hash, version, mode and effective capabilities. A
procedure with unavailable required capabilities returns limited guidance with
an explicit list of unperformed capabilities. It does not create those tools,
change file grants or claim that its procedure was executed. Its current host
capability preamble takes precedence over descriptions of the historical M2
baseline in the unchanged source.

Only these procedures are eligible for automatic selection:

- `athena-research-intake`
- `athena-source-provenance`
- `athena-data-quality`

All twelve can be explicitly selected when enabled and permitted for the agent's
role. Automatic eligibility is not itself a decision that a procedure is relevant.
Custom plugin skills require explicit selection. The bundled procedure package
can be disabled; its individual procedures can also be disabled. A disabled
selection affects new runs while previously admitted runs retain their pins.

## Declarative plugin manifest

An Athena plugin is a bounded JSON package of skill bodies and/or explicit MCP
server descriptors. The example below is an installable **format example**, not
an installed or externally verified server:

```json
{
  "schemaVersion": 1,
  "id": "laboratory-tools",
  "name": "Laboratory tools",
  "description": "An explicitly configured laboratory MCP connection.",
  "version": "1.0.0",
  "mcpServers": [
    {
      "id": "measurements",
      "name": "Laboratory measurements",
      "transport": "streamable-http",
      "url": "https://mcp.example.org/mcp",
      "allowedTools": ["inspect_measurement"],
      "auth": "bearer",
      "timeoutMs": 10000
    }
  ]
}
```

A skill entry has `id`, `name`, `description`, `version`, `body`, `roles`
(`parent` and/or `child`) and `requiredCapabilities`. Its runtime ID is
`<plugin-id>/<skill-id>`; bundled Athena skills retain their existing IDs.

No script, command, environment variable, package lifecycle hook, external file
path or executable extension is accepted. Installation does not fetch URLs or
install dependencies. `stdio` descriptors are rejected with an unsupported
transport error. Such a server may be operated separately by its owner and
exposed through a supported HTTP endpoint; Athena does not claim to sandbox a
process it did not launch.

Installations and updates begin disabled. Changing package content requires a
new semantic plugin version. Every configured server must be checked before the
plugin can be enabled. The accepted check binds endpoint configuration, protocol,
server identity, allowed tools and their full accepted schemas. Rechecking an
already enabled plugin with a changed tool/schema digest or changed credential
reference disables it until the user enables the changed configuration.

Project settings use an optimistic configuration revision. A stale save or a
check finishing after its configuration changed is rejected. Installed packages
and selected permissions are project scoped. Removing a package removes future
selection, while archived versions and prior usage evidence remain available.

## External MCP transport

Supported transport is MCP `2025-06-18` Streamable HTTP with JSON or SSE POST
responses. Each execution opens a fresh MCP session, initializes, lists the
allowed tools again, compares identity and schema against the run's verification,
and only then calls the selected tool. Listing pagination is bounded. Session
and protocol headers are preserved, and an assigned session is closed with a
best-effort DELETE. No automatic reconnect/replay occurs after a failed request.

Endpoint policy permits HTTPS and explicit loopback HTTP. URL credentials,
query parameters, fragments and redirects are rejected. An optional bearer token
is supplied separately by the host. Provider credentials and environment
variables are not inherited. The stored descriptor contains only an authentication
mode; the host may bind a separate immutable external credential reference after
a successful check. Public snapshots report credential presence, not its value
or reference. Known token echoes are redacted before results or errors leave
the client.

The client sends no roots, sampling or elicitation capability, does not invoke
server-requested tools and does not follow resource links. Tool results may
contain text and optional structured JSON. Image, audio, linked-resource and
embedded-resource result types fail with an unsupported-result error. Host
publication uses the actual accepted JSON bytes and host-calculated SHA-256;
external text cannot grant local paths or select artifact identities.

The schema validator supports a bounded subset of JSON Schema: types, object
properties/required/additionalProperties, arrays/items/uniqueness, enum/const,
anyOf/oneOf/allOf/not, length/count bounds and numeric bounds/multipleOf. It does
not resolve `$ref` or execute regular expressions. Unsupported keywords fail
connection verification instead of being silently ignored. Input/output schemas
must describe an object. Schemas, requests, responses, pagination, depth and
validation complexity are bounded; there is no coercion.

Cancellation aborts the local request and sends a best-effort MCP cancellation
notification with the original request ID. Remote cancellation remains
**unconfirmed**: neither a disconnected HTTP connection nor an accepted
notification proves that an external operation stopped. Results received after
local cancellation must not be published. Existing recovery rules still require
an explicit retry; no exactly-once remote side-effect guarantee is implied.

Protocol references:

- [MCP Streamable HTTP transport, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP tools and structured output, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

## Immutable run selection and evidence

`ExtensionStore.pin(projectId)` produces a serialized snapshot of enabled plugin
revisions, selected skill metadata and verified external definitions. The host
persists this at run admission and carries it to parent, child, retry and
reconciliation. Archive digests, skill-body hashes and schema digests are checked
when used. Changing current settings does not mutate an existing pin. An absent
legacy pin means an empty extension selection, not today's enabled plugins.

Old plugin revisions and credential references are retained for run provenance
and retry. A missing or changed pinned revision must reject admission before a
retry starts. An uninstalled plugin is not needed merely to download already
published result bytes; result receipts remain owned by the original process,
conversation and project.

## Verification boundary

The module tests exercise real loopback HTTP JSON/SSE sessions and the host's
actual SQLite store. They check explicit credentials, redaction, schema drift,
invalid arguments, pagination, redirect rejection, malformed/oversized output,
cancellation and timeout, catalog integrity, role/project boundaries, update and
removal, stale configuration, old pins and retained usage evidence. They do not
establish access to a particular third-party service, native Mac operation or
actual ChatGPT-account inference. Those require the exact integrated candidate's
separate acceptance evidence.

## GitHub repository connection

In a project conversation, open **Settings → Tools & plugins → Install GitHub plugin**.
Enter a GitHub personal access token and choose **Connect and enable GitHub**. For a
fine-grained token, select the repositories you want to use and grant read access
to their contents and metadata. Athena discovers the upstream tools before enabling
the package for new runs. Workers can search repositories, list branches and list
commits. The project card also supports rechecking, disabling and removing the
connection. [GitHub MCP Server toolsets](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
