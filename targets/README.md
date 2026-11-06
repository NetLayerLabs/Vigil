# Target manifests

A target manifest tells Vigil which service it guards and how to handle it. Vigil keeps a git working copy of that service, starts it, sends it traffic and canary probes, runs its tests, and promotes, reverts or rolls it back.

Vigil reads `targets/checkout-api.target.json`, the demo checkout service, unless `VIGIL_TARGET` points at another manifest.

```bash
VIGIL_TARGET=targets/my-service.target.json npm start
```

| Field | Required | What it does |
| --- | --- | --- |
| `name` | yes | Lowercase identifier. The working copy is `.vigil-state/<name>-live-<port>`. |
| `source` | yes | `{ "path": "services/x" }` copies a folder from this repository into a new git repository. `{ "git": "https://…", "ref": "main" }` clones a repository instead. |
| `versions.lastKnownGood` | yes | The git tag that rollback resets to. For a cloned repository, Vigil creates this tag at `ref` if it doesn't exist. |
| `versions.hotfix` | yes | The tag a promoted fix gets. |
| `codePaths` | yes | Folders containing code. Diffs, changed-line counts and the suspect file are read from these. |
| `install` | no | Runs once in a fresh working copy, for example `["npm", "ci"]`. |
| `start` | yes | The command that starts the service. A first word of `node` means the Node.js that runs Vigil. |
| `test` | yes | The test command. With TAP output, each test becomes a row in the verification matrix; otherwise the exit code decides. |
| `portEnv` | yes | Environment variables to set to the port the service must listen on, for example `["PORT"]`. |
| `healthPath` | yes | Must answer 200 once the service is up. If the response JSON includes `deployedVersion`, it must match the release. |
| `metricsPath` | no | JSON with `deployedVersion`, `pid`, `totalRequests`, `totalErrors`, `errorRatePct` and `p99LatencyMs`. Without it, the War Room shows health only. |
| `endpoint` | yes | The request (`method` and `path`) used for traffic, reproduction, the staging replay and the canaries. |
| `traffic` | yes | Request bodies sent in rotation as steady background traffic. `[]` sends none. |
| `canaries` | yes | `[{ "name", "body" }]`. Every probe must return 2xx after a release before the incident can close. |
| `faults` | yes | `"builtin-checkout"` enables the three seeded regressions, which apply to the demo service only. `"none"` turns chaos releases off. |

The service and its tests run with a minimal environment and none of Vigil's secrets. With `VIGIL_SERVICE_USER` set, they also run as that unprivileged user. Alerts from a monitoring tool (`/api/webhooks/{alertmanager,sentry,generic}`, see the README) open an incident only while a release Vigil deployed and can trace is live, so it knows which commit to revert or patch. Today only the demo service's chaos releases are deployed that way; opening incidents for releases shipped by your own pipeline is not built yet.
