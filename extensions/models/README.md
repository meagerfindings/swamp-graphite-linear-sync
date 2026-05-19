# @mgreten/graphite-linear-sync

Reconcile GitHub/Graphite PR stacks with Linear issue states.

Scans your open PRs for Linear ticket references in PR bodies (e.g. `ENG-123`),
compares PR merge status against the corresponding Linear issue state, and
optionally transitions Linear issues to match.

## Key features

- **Multi-PR conflict resolution**: When multiple PRs reference the same Linear
  issue, the expected state is determined by the least-progressed open PR. An
  issue is only marked Done when *all* referencing PRs are merged.
- **Graphite stack filtering**: Optionally scope the scan to a specific Graphite
  stack using the `branch` argument.
- **Dry-run by default**: The `true_up` method previews transitions without
  applying them unless you explicitly set `dryRun: false`.

## Prerequisites

- **Linear API key**: A personal API key (`lin_api_...`) from
  https://linear.app/settings/api
- **GitHub CLI**: `gh` must be installed and authenticated (`gh auth login`)
- **Graphite CLI** (optional): `gt` enables stack-aware filtering

## Setup

```bash
swamp extension pull @mgreten/graphite-linear-sync
swamp model create @mgreten/graphite-linear-sync my-sync
swamp model edit my-sync
```

Configure `globalArguments`:

```yaml
globalArguments:
  apiKey: '${{ vault.get(my-vault, linear_key) }}'
  teamKeys:
    - ENG
  repo: myorg/my-repo
  repoPath: /path/to/my-repo
```

## Usage

```bash
# Scan all your open PRs
swamp model method run my-sync scan_stack

# Scan a specific Graphite stack
swamp model method run my-sync scan_stack --input '{"branch": "feat/my-feature"}'

# Preview Linear transitions (dry run, default)
swamp model method run my-sync true_up

# Apply Linear transitions
swamp model method run my-sync true_up --input '{"dryRun": false}'
```

## State mapping

| PR status       | Expected Linear state |
| --------------- | --------------------- |
| Open (draft)    | In Progress           |
| Open (non-draft)| In Review             |
| Merged          | Done                  |
| Closed          | Canceled              |

## License

MIT
