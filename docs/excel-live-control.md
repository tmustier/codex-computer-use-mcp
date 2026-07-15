# Native ChatGPT Excel live control

Observed on 15 July 2026. This document describes OpenAI's official ChatGPT for Excel integration. It is adjacent to, but separate from, the Computer Use bridge in this repository.

## Findings

OpenAI has two distinct Excel mechanisms:

1. The ChatGPT task pane has its own in-pane agent and workbook tools.
2. A brokered document-control path lets an external Codex client discover a connected Excel executor and dispatch one workbook tool to it.

Both paths ultimately use the task pane's Office.js executor. Neither path uses accessibility automation to read or edit workbook cells. Computer Use remains useful for installing or opening the add-in, choosing the intended workbook, focusing Excel when requested, and inspecting visible UI state.

The official Microsoft Marketplace app is `WA200010215`. Its Office add-in ID is `cba9fc06-6fc9-492e-9525-923870a3b909`; its task pane is served from:

```text
https://bps.openai.com/basispoints/extension/360590d7-f8f9-4d88-bf75-0edfe0a4b9f3/
```

The installed Marketplace UI identified the publisher as OpenAI, LLC, version `2.0.0.0`, and the products as Excel and PowerPoint. The Office permission is read/write document access.

## Evidence and confidence

The sources establish different things and should not be conflated.

| Evidence | Establishes | Does not establish |
|---|---|---|
| `codex_document_control.get_document_tool_schemas` response | Exact registry descriptions and input schemas for `excel:<tool>@1` | That a particular live session currently advertises those keys |
| Deployed `excel-executor-DP9EXmuq.js` | The exact tool/version allowlist and current local dispatch implementation | A live session's server-visible state |
| `list_document_sessions` | The connected sessions and `supported_tools[]` actually visible to the caller | Schema details beyond each advertised name/version |
| `excel-live-control` skill | Intended selection and execution workflow | Runtime truth if it disagrees with discovery |
| Marketplace manifest and installed task pane | Official app identity, hosts, permissions, and deployment | The dynamic workbook tool contract |

The registry lookup succeeded for all 17 keys even when session discovery returned no executors. This confirms that schema lookup is a registry operation: it accepts `surface`, `tool_name`, and `version`, but no `executor_session_id`. Clients must still begin with session discovery because registry existence is not proof that the selected executor advertises a tool.

The exact captured registry result is in [`excel-live-tool-schemas.json`](excel-live-tool-schemas.json). Its SHA-256 is:

```text
85039a479270294b8a8dd780c6048bc49a87aa4c3e3ebb8b11695a46136e3709
```

### Live verification status

The official Marketplace add-in was installed and opened in a real Excel workbook. Schema retrieval succeeded, but add-in authentication had not completed at the time of capture. Consequently, the observed `list_document_sessions` result was:

```json
{"executors":[]}
```

The deployed allowlist, executor behavior, and registry contract are therefore confirmed independently, but the following are not yet live-verified:

- a selected session's actual `supported_tools[]`;
- a read-only command delivered through Arc and its terminal callback;
- a controlled write followed by a document-tool read-back.

This limitation is material: the document below does not represent static executor inspection as successful live command execution.

## Broker contract

The connected app is `connector_openai_codex_document_control`. It exposes three operations in the `codex_document_control` namespace.

### `list_document_sessions`

Lists currently connected document executors, optionally filtered by `excel`, `powerpoint`, or `sheets`. A caller selects the exact workbook by its returned identity, then copies the session's `executor_session_id` and the selected `supported_tools[].name` and `.version` verbatim.

### `get_document_tool_schemas`

Accepts up to 100 lookup items:

```json
{
  "items": [
    {
      "surface": "excel",
      "tool_name": "read_ranges",
      "version": "1"
    }
  ]
}
```

It returns each tool's exact description and `input_schema`. It does not accept a session ID and does not advertise an output schema.

### `execute_document_command`

Dispatches one command:

```json
{
  "executor_session_id": "<copied from discovery>",
  "idempotency_key": "<stable for this logical command>",
  "tool_name": "<copied from supported_tools[]>",
  "args": {
    "<must match the fetched input_schema>": "..."
  }
}
```

Reuse an idempotency key only when retrying the same logical command. Use a new key for a different command.

## End-to-end control flow

```text
Codex client
  └─ codex_document_control.list_document_sessions
      └─ OpenAI document-control service
          └─ connected executor registrations

Codex client
  └─ codex_document_control.get_document_tool_schemas
      └─ OpenAI tool-schema registry

Codex client
  └─ codex_document_control.execute_document_command
      └─ OpenAI document-control service
          └─ Arc command topic
              └─ Client Sync WebSocket
                  └─ ChatGPT Office task pane
                      └─ Excel Arc executor
                          └─ direct tool or run_officejs
                              └─ Office.js RequestContext
                                  └─ active workbook
                      └─ POST terminal result callback
                          └─ OpenAI document-control service
                              └─ Codex tool result
```

The deployed task pane calls the internal transport `Arc`.

### Executor registration

Remote control requires an authenticated ChatGPT session, Excel or PowerPoint, and the `arc_control_transport_enabled` feature. The task pane's “Allow Codex control” setting must also remain enabled.

For Excel, the task pane:

1. loads the Excel executor;
2. persists a UUID in Office document settings under `bps.codex_control.document_id`;
3. obtains the document title, preferring `workbook.name` when ExcelApi 1.7 is available;
4. registers with `POST arc/executors/register` using:
   - `surface`;
   - `document_id`;
   - `document_title`;
   - the exact `supported_tools` list;
5. receives an `executor_session_id` and `client_sync` bootstrap;
6. opens the server-provided `client_sync.websocket_url`;
7. sends Client Sync `connect` and `subscribe` commands for `command_topic_id`;
8. calls `POST arc/executors/<session>/ready` after the subscription succeeds;
9. calls `POST arc/executors/<session>/heartbeat` every 60 seconds.

If the WebSocket closes, the executor refreshes its bootstrap and reconnects. Registration and connection failures use exponential backoff with jitter.

### Command receipt and validation

The subscribed topic delivers `arc_tool_call` events. Before running Office.js, the task pane verifies:

- `executor_session_id` matches the active executor;
- `command_id` is present;
- `document_id` matches the registered workbook;
- `tool_name` is in the executor's current allowlist;
- `args` is an object;
- `issued_at` and `expires_at` are valid timestamps;
- the command has not expired.

Commands execute serially. Duplicate deliveries are deduplicated by `command_id`; a duplicate retries only a previously failed result callback, not workbook execution.

### Execution and callback

The executor invokes the selected local tool with `{commandId, toolName, arguments}`. A successful callback to `POST arc/commands/<command>/result` contains:

```json
{
  "executor_session_id": "...",
  "document_id": "...",
  "status": "succeeded",
  "result": "<tool-specific JSON value or null>",
  "completed_at": "<ISO timestamp>"
}
```

A failure uses `status: "failed"` and an `error` object. The task pane classifies malformed commands, unsupported tools, malformed arguments, expired commands, Office.js failures, invalid arguments, and other execution failures. Result callbacks have a 5-second timeout and retry after 5, 15, and 30 seconds while the command remains retained.

`run_officejs` is explicitly non-transactional. Its failure details say partial execution is possible and include normalized Office error fields and captured sandbox logs when available.

## Excel tool contract

The deployed Excel executor's static `supportedTools` list contains exactly these 17 records, all at version `1`:

| Tool | Implemented output behavior |
|---|---|
| `read_ranges` | Compact `<ranges>...</ranges>` XML by default, containing sheet/address and cell values, displayed text, formulas, and optional styles/number formats. `cellLimit` bounds non-empty returned cells. |
| `search_workbook` | `{"matches":[{"address","value","sheet"}, ...]}`. |
| `list_items` | `{"charts":[],"tables":[],"pivotTables":[]}` with type-specific IDs, names, properties, positions, and ranges/source where available. |
| `write_range` | `{"cells":["Sheet!A1", ...],"writesApplied":n,"notesApplied":boolean}`. |
| `clear_range` | `{"cleared":true}`. |
| `update_sheet` | `{"status":"ok","operation":"..."}`. |
| `update_workbook` | Create returns `{id,name,position}`; duplicate returns `{status,operation,id,name,position}`; rename/delete return `{status,operation,id,name}`. |
| `copy_range_to` | `{"copied":true,"sheet":"<name>"}`. |
| `read_range_image` | An array of Responses-style content items: optional `input_text` metadata followed by an `input_image` whose URL is a PNG data URL. |
| `run_officejs` | `{"status":"ok","result":<JSON value>,"logs":[]}`; `result` is omitted when the function body returns `undefined`. |
| `read_sheets_metadata` | Array of `{id,name,position,visibility,usedRange,isActive}`. `usedRange` is null or `{address,rowCount,columnCount}`. |
| `resize_range` | `{"resized":true}`. |
| `update_sheet_view` | `{sheetId,status:"ok"}` plus the supplied normalized view values. |
| `format_range` | `{"formatted":true,"address","rowCount","columnCount"}`. |
| `chart` | Create returns `{status:"created",id,name,chartType}`; update `{status:"updated",id,name}`; delete `{status:"deleted",id}`. |
| `table` | Create returns `{status:"created",id,name,address}`; update `{status:"updated",id,name}`; delete `{status:"deleted",id}`. |
| `pivot_table` | Create returns `{status:"created",id,name}`; update returns `{status:"updated",id,name}`; delete returns `{status:"deleted",id}`. |

These output shapes come from the deployed executor because the schema registry currently advertises input schemas only.

## Contract and implementation discrepancies

The captured schemas are authoritative for constructing calls. The deployed executor nevertheless contains several observable differences worth recording:

- `read_ranges` has an unadvertised `includeXml` switch and defaults it to `true`; schema-valid calls therefore return XML, not the executor's alternative JSON representation.
- `search_workbook` declares `offset` and `options.ignoreDiacritics`, but the deployed implementation does not read either value.
- `update_workbook` declares `rows` and `columns` for sheet creation, but the deployed implementation does not use them.
- `resize_range` marks only `sheetId` as required, while the executor also rejects a missing `range` and requires at least one of `width` or `height`.
- The `chart` schema says `chartType` is required for create, but the executor requires only `source` and defaults the type to clustered columns.
- Pivot row and column entries declare `sort`; the deployed implementation applies hierarchy placement and subtotals but does not apply that sort field.
- `run_officejs.destructive` is legacy UI metadata. The deployed executor always allows mutations because the containing write-tool gate already governs the call.

These are implementation observations, not instructions to send undeclared arguments.

## Direct tools versus `run_officejs`

Use the direct tools for normal reads, sparse writes, structural sheet changes, formatting, tables, charts, and pivots. Use `run_officejs` for compact scans, coherent multi-step batches, or Office.js capabilities that the direct contract cannot express efficiently.

For Excel scripts:

- provide only the function body
- use the supplied `ctx` and `Excel` objects
- do not call `Excel.run()`
- use explicit worksheet names and A1 ranges
- return only JSON-serializable values
- inspect workbook state after a failure because execution is non-transactional

The deployed executor rejects script bodies over 50,000 characters and rejects bodies containing `Excel.run(`.

## Separate in-pane agent path

The task pane's ordinary chat experience has a separate Responses API agent loop. That loop sends a surface-specific tools-version metadata value:

```text
tools-excel-core-2026-06-16-3af59f22
```

The value appears in `bps_tools_version_id` request metadata and in the response header `X-OpenAI-Internal-Basispoints-Tools-Version-Id`. It is not the same field as Arc's per-tool `supported_tools[].version`, which is currently `"1"` for every Excel tool.

The bundle also contains a WebSocket evaluation tool-host protocol with `runner_ready`, `initialize_tool_host`, `execute_tool_call`, and `export_pdf`. That protocol is labelled `eval-tool-host` in the deployed code. It is not the Arc document-control channel and should not be used to explain connected Codex session discovery or command delivery.

## Required live workflow

For a live workbook operation:

1. Use Computer Use only to open Excel, confirm the intended workbook and task pane, and restore focus when the executor reports `needs_focus`.
2. Call `list_document_sessions` and select the exact Excel session by returned document identity.
3. Copy the session's exact tool names and versions; do not substitute the deployed allowlist for discovery.
4. Fetch every needed input schema with `get_document_tool_schemas`.
5. Execute one command with a caller-stable idempotency key.
6. Read back the affected range or metadata through document-control tools to verify writes.

If discovery returns no executors, the task pane is not connected from the caller's perspective. Installing the add-in or finding registry schemas does not change that result.

## Capture provenance

The live-control route came from OpenAI's primary-runtime `spreadsheets` plugin version `26.709.11516`. No standalone Excel plugin was present in the ChatGPT application's bundled Computer Use directory; that signed component is a separate broker.

Relevant deployed asset hashes:

```text
excel-executor-DP9EXmuq.js  832b5483d58663f4cdf05b3d120cc43b328a4083c2e801d1ab55f25d93b8f5a0
x-square-BY1qRJXO.js        dcbee1259e411aa72847ac47893936d39d283dbe8f7295a28ad8b5187d4e4d5e
client-info-DUZ9ac-1.js     d47adf387cf68aff12ba35185d8fb4f5c1117c7cb4c0fe48653eeed7be16c114
```

The deployed JavaScript source-map URLs returned HTTP 404, so executor analysis used the shipped minified assets and locally formatted copies.
