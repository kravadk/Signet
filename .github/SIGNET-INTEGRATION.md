# GitHub Integration

Signet ships a reusable workflow at `.github/workflows/signet-release.yml`.
It turns a GitHub run into a visible provenance Check:

- snapshots the checked-out repo and uploads the manifest/archive to Walrus;
- publishes a Signet release through `forge release --pr <merged-pr-id>`;
- runs `forge verify --release <release-id>`;
- writes GitHub job outputs and a step summary with tree hash, release id, PR id,
  verification level, and reverify anchors.

## Required Secrets

| Secret | Required | Purpose |
|---|---:|---|
| `FORGE_OWNER_KEY` | yes | `suiprivkey1...` for the owner wallet that holds the `RepoOwnerCap`. |

For testnet, no Walrus secret is required because Signet uses the public testnet
publisher. Mainnet releases need the local `walrus` CLI path/config available to
the runner, because mainnet Walrus writes real WAL/SUI.

## Required Inputs

| Input | Purpose |
|---|---|
| `repo_id` | Signet `Repository` object id. |
| `owner_cap_id` | `RepoOwnerCap` object id controlled by `FORGE_OWNER_KEY`. |
| `reputation_id` | `RepoReputation` object id for local CLI state compatibility. |
| `repo_name` | Name embedded in the Walrus snapshot manifest. |
| `tag` | Release tag, for example `v1.2.3`. |
| `merged_pr_id` | Merged Signet PR id; this creates the v2 direct release link. |
| `current_manifest_blob` | Optional previous/current manifest blob for snapshot lineage. |
| `github_artifact_name` | Optional Actions artifact containing `.signet/artifact.tgz` and `.signet/report.txt`. |

## Copy-Paste Workflow

Create `.github/workflows/release-to-signet.yml` in a downstream repo:

```yaml
name: Release to Signet

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag
        required: true
        default: v0.1.0
      merged_pr_id:
        description: Merged Signet PR object id
        required: true

permissions:
  contents: read

jobs:
  test-and-package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Build report and artifact
        run: |
          set -euo pipefail
          mkdir -p .signet
          {
            echo "GitHub run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
            echo "Commit: $GITHUB_SHA"
            npm test 2>&1
          } | tee .signet/report.txt
          tar --exclude=.git --exclude=node_modules --exclude=.signet -czf .signet/artifact.tgz .
      - uses: actions/upload-artifact@v4
        with:
          name: signet-release-inputs
          path: .signet

  signet:
    needs: test-and-package
    uses: ./.github/workflows/signet-release.yml
    secrets:
      FORGE_OWNER_KEY: ${{ secrets.FORGE_OWNER_KEY }}
    with:
      network: testnet
      repo_id: "0x..."
      owner_cap_id: "0x..."
      reputation_id: "0x..."
      repo_name: "my-signet-repo"
      branch: main
      tag: ${{ inputs.tag }}
      merged_pr_id: ${{ inputs.merged_pr_id }}
      artifact_path: .signet/artifact.tgz
      report_path: .signet/report.txt
      current_manifest_blob: ""
      github_artifact_name: signet-release-inputs
```

If the reusable workflow lives in a separate Signet repo, replace `uses:
./.github/workflows/signet-release.yml` with
`uses: <owner>/<signet-repo>/.github/workflows/signet-release.yml@main`.

## Check Outputs

The `signet` job exposes:

- `release_id`
- `pr_id`
- `tree_hash`
- `verification_level`
- `verification_pass`

The step summary includes the exact reverify command:

```sh
FORGE_NETWORK=testnet npm --prefix app run forge -- verify --release <release-id>
```
