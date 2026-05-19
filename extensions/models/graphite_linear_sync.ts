/**
 * @module @mgreten/graphite-linear-sync
 *
 * Reconcile GitHub/Graphite PR stacks with Linear issue states. Scans PRs for
 * Linear ticket references in PR bodies, compares PR merge status against
 * Linear issue state, and optionally transitions Linear issues to match.
 *
 * When multiple PRs reference the same Linear issue, the expected state is
 * determined by the least-progressed open PR — an issue is only marked Done
 * when all referencing PRs are merged.
 *
 * Auth: requires a Linear personal API key (`lin_api_...`) stored as a
 * sensitive global argument. Obtain one from https://linear.app/settings/api.
 * GitHub: uses the `gh` CLI (must be authenticated via `gh auth login`).
 * Graphite: optionally uses the `gt` CLI for stack detection.
 *
 * @example
 * ```bash
 * # Scan all your open PRs
 * swamp model method run gl-sync scan_stack
 *
 * # Scan a specific Graphite stack
 * swamp model method run gl-sync scan_stack --input '{"branch": "feat/my-feature"}'
 *
 * # Preview Linear transitions (dry run, default)
 * swamp model method run gl-sync true_up
 *
 * # Apply Linear transitions
 * swamp model method run gl-sync true_up --input '{"dryRun": false}'
 * ```
 */

import { z } from "npm:zod@4";

// =============================================================================
// Schemas
// =============================================================================

/**
 * Global arguments shared across all methods.
 *
 * - `apiKey` -- Linear personal API key, marked sensitive so swamp never logs it.
 * - `teamKeys` -- Linear team keys used to scope PR body scanning and issue queries.
 * - `repo` -- GitHub owner/repo (e.g. "myorg/my-repo") for PR lookups via `gh`.
 * - `repoPath` -- Local filesystem path to the repo, used for `gt` stack detection.
 */
const GlobalArgsSchema: z.ZodObject<{
  apiKey: z.ZodString;
  teamKeys: z.ZodArray<z.ZodString>;
  repo: z.ZodString;
  repoPath: z.ZodString;
}> = z.object({
  apiKey: z
    .string()
    .describe("Linear personal API key (lin_api_...)")
    .meta({ sensitive: true }),
  teamKeys: z
    .array(z.string())
    .describe(
      "Linear team keys to scope to (e.g. ['ENG']). Used for extracting ticket IDs from PR bodies.",
    ),
  repo: z
    .string()
    .describe("GitHub owner/repo for PR lookups (e.g. 'myorg/my-repo')"),
  repoPath: z
    .string()
    .describe(
      "Local path to the repo for Graphite stack detection (e.g. '/home/user/repos/my-repo')",
    ),
});

/** Summary of a single GitHub pull request. */
const PrSummarySchema: z.ZodObject<{
  number: z.ZodNumber;
  title: z.ZodString;
  headRefName: z.ZodString;
  state: z.ZodEnum<["OPEN", "MERGED", "CLOSED"]>;
  isDraft: z.ZodBoolean;
  mergedAt: z.ZodNullable<z.ZodString>;
  url: z.ZodString;
  linearIds: z.ZodArray<z.ZodString>;
}> = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  mergedAt: z.string().nullable(),
  url: z.string(),
  linearIds: z.array(z.string()),
});

/** Current state of a Linear issue. */
const LinearIssueStateSchema: z.ZodObject<{
  id: z.ZodString;
  identifier: z.ZodString;
  title: z.ZodString;
  url: z.ZodString;
  stateName: z.ZodString;
  stateType: z.ZodString;
}> = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  stateName: z.string(),
  stateType: z.string(),
});

/** A reconciliation group: one Linear issue with all PRs that reference it. */
const SyncPairSchema: z.ZodObject<{
  prs: z.ZodArray<typeof PrSummarySchema>;
  linearIssue: typeof LinearIssueStateSchema;
  currentLinearState: z.ZodString;
  expectedLinearState: z.ZodString;
  needsUpdate: z.ZodBoolean;
}> = z.object({
  prs: z.array(PrSummarySchema),
  linearIssue: LinearIssueStateSchema,
  currentLinearState: z.string(),
  expectedLinearState: z.string(),
  needsUpdate: z.boolean(),
});

/** Full scan result: all PR-to-Linear reconciliation data. */
const ScanResultSchema: z.ZodObject<{
  scannedAt: z.ZodString;
  repo: z.ZodString;
  prCount: z.ZodNumber;
  pairs: z.ZodArray<typeof SyncPairSchema>;
  prsWithoutLinear: z.ZodArray<typeof PrSummarySchema>;
  summary: z.ZodString;
}> = z.object({
  scannedAt: z.string(),
  repo: z.string(),
  prCount: z.number(),
  pairs: z.array(SyncPairSchema),
  prsWithoutLinear: z.array(PrSummarySchema),
  summary: z.string(),
});

/** Result of applying state transitions to Linear issues. */
const TrueUpResultSchema: z.ZodObject<{
  executedAt: z.ZodString;
  transitions: z.ZodArray<
    z.ZodObject<{
      identifier: z.ZodString;
      from: z.ZodString;
      to: z.ZodString;
      success: z.ZodBoolean;
      error: z.ZodNullable<z.ZodString>;
    }>
  >;
  summary: z.ZodString;
}> = z.object({
  executedAt: z.string(),
  transitions: z.array(
    z.object({
      identifier: z.string(),
      from: z.string(),
      to: z.string(),
      success: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  summary: z.string(),
});

// =============================================================================
// Linear GraphQL helpers
// =============================================================================

/** Linear GraphQL API endpoint. */
const LINEAR_ENDPOINT: string = "https://api.linear.app/graphql";

/** Shape of a raw Linear GraphQL response. */
interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a GraphQL query against the Linear API.
 *
 * @param apiKey - Linear personal API key used for authorization.
 * @param query - GraphQL query string.
 * @param variables - Optional variables to pass with the query.
 * @returns The `data` portion of the GraphQL response.
 * @throws On HTTP errors, GraphQL errors, or missing data.
 */
async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const resp: Response = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`Linear HTTP ${resp.status}: ${await resp.text()}`);
  }
  const payload = (await resp.json()) as GqlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(
      `Linear GQL: ${payload.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!payload.data) throw new Error("Linear GQL returned no data");
  return payload.data;
}

/** Raw issue node shape from Linear GraphQL. */
interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { id: string; name: string; type: string };
}

/** Workflow state node from Linear GraphQL. */
interface WorkflowStateNode {
  id: string;
  name: string;
  type: string;
}

/**
 * Fetch a batch of Linear issues by their identifiers (e.g. ["ENG-315"]).
 *
 * Parses identifiers into team key + number, then queries by team + number
 * filter (Linear's IssueFilter doesn't support direct identifier filtering).
 *
 * @param apiKey - Linear personal API key.
 * @param identifiers - Array of issue identifiers (e.g. ["ENG-315", "ENG-42"]).
 * @returns Matching Linear issue nodes.
 */
async function fetchLinearIssues(
  apiKey: string,
  identifiers: string[],
): Promise<LinearIssueNode[]> {
  if (identifiers.length === 0) return [];
  const parsed: Array<{ teamKey: string; number: number }> = identifiers.map(
    (id) => {
      const [teamKey, numStr] = id.split("-");
      return { teamKey, number: parseInt(numStr, 10) };
    },
  );
  const teamKeys: string[] = [...new Set(parsed.map((p) => p.teamKey))];
  const numbers: number[] = parsed.map((p) => p.number);

  const result = await gql<{ issues: { nodes: LinearIssueNode[] } }>(
    apiKey,
    `query($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first) {
        nodes {
          id identifier title url
          state { id name type }
        }
      }
    }`,
    {
      filter: {
        team: { key: { in: teamKeys } },
        number: { in: numbers },
      },
      first: Math.max(identifiers.length, 50),
    },
  );
  const idSet: Set<string> = new Set(identifiers);
  return result.issues.nodes.filter((n) => idSet.has(n.identifier));
}

/**
 * Fetch workflow states for a team so we can resolve state IDs by name.
 *
 * @param apiKey - Linear personal API key.
 * @param teamKey - Linear team key (e.g. "ENG").
 * @returns Array of workflow state nodes.
 */
async function fetchTeamStates(
  apiKey: string,
  teamKey: string,
): Promise<WorkflowStateNode[]> {
  const result = await gql<{
    workflowStates: { nodes: WorkflowStateNode[] };
  }>(
    apiKey,
    `query($filter: WorkflowStateFilter) {
      workflowStates(filter: $filter) {
        nodes { id name type }
      }
    }`,
    { filter: { team: { key: { eq: teamKey } } } },
  );
  return result.workflowStates.nodes;
}

/**
 * Transition a Linear issue to a new workflow state.
 *
 * @param apiKey - Linear personal API key.
 * @param issueId - Linear issue ID (UUID).
 * @param stateId - Target workflow state ID (UUID).
 */
async function transitionIssue(
  apiKey: string,
  issueId: string,
  stateId: string,
): Promise<void> {
  await gql<{ issueUpdate: { success: boolean } }>(
    apiKey,
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { stateId } },
  );
}

// =============================================================================
// GitHub/Graphite helpers
// =============================================================================

/** Raw PR shape from `gh pr list --json`. */
interface GhPr {
  number: number;
  title: string;
  headRefName: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  url: string;
  body: string;
}

/**
 * Extract Linear issue identifiers from a PR body.
 *
 * Scans for patterns like "ENG-123" based on the configured team keys.
 *
 * @param body - PR body text.
 * @param teamKeys - Linear team keys to look for.
 * @returns Deduplicated array of identifiers found.
 */
function extractLinearIds(body: string, teamKeys: string[]): string[] {
  const pattern: RegExp = new RegExp(
    `(${teamKeys.join("|")})-\\d+`,
    "g",
  );
  const matches: string[] = body.match(pattern) ?? [];
  return [...new Set(matches)];
}

/** State priority: lower number = less progressed. */
const STATE_PRIORITY: Record<string, number> = {
  "In Progress": 0,
  "In Review": 1,
  "Done": 2,
  "Canceled": 3,
};

/**
 * Determine expected Linear state for a single PR.
 *
 * @param pr - PR summary.
 * @returns Expected Linear state name.
 */
function prExpectedState(pr: z.infer<typeof PrSummarySchema>): string {
  if (pr.state === "MERGED") return "Done";
  if (pr.state === "CLOSED") return "Canceled";
  if (pr.isDraft) return "In Progress";
  return "In Review";
}

/**
 * Determine expected Linear state when multiple PRs reference one issue.
 *
 * Uses the least-progressed open PR to gate the issue state. If all PRs
 * are merged, returns Done. Closed PRs are ignored unless they're the only ones.
 *
 * @param prs - All PRs referencing this Linear issue.
 * @returns Expected Linear state name.
 */
function expectedStateForIssue(
  prs: z.infer<typeof PrSummarySchema>[],
): string {
  const states: string[] = prs.map(prExpectedState);
  const active: string[] = states.filter((s) => s !== "Canceled");
  if (active.length === 0) return "Canceled";
  return active.sort(
    (a, b) => (STATE_PRIORITY[a] ?? 99) - (STATE_PRIORITY[b] ?? 99),
  )[0];
}

// =============================================================================
// Model context type
// =============================================================================

/** Swamp model execution context. */
type ModelContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model
// =============================================================================

/**
 * Swamp model definition for `@mgreten/graphite-linear-sync`.
 *
 * Provides two methods:
 * - `scan_stack` -- scan PRs for Linear references and produce a reconciliation report
 * - `true_up` -- transition Linear issues to match PR states
 */
export const model = {
  type: "@mgreten/graphite-linear-sync",
  version: "2026.05.19.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    scan_result: {
      description:
        "Reconciliation scan: PRs grouped by Linear issue with state comparison",
      schema: ScanResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 14,
    },
    true_up_result: {
      description: "Results of transitioning Linear issues to match PR states",
      schema: TrueUpResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 14,
    },
  },

  methods: {
    scan_stack: {
      description:
        "Scan open PRs (optionally filtered to a Graphite stack) for Linear ticket references, compare PR merge status against Linear issue state, and produce a reconciliation report. When multiple PRs reference the same issue, the expected state is gated by the least-progressed open PR.",
      arguments: z.object({
        branch: z
          .string()
          .optional()
          .describe(
            "Branch name to scope to a specific Graphite stack. Omit to scan all your open PRs.",
          ),
        includeRecent: z
          .boolean()
          .default(true)
          .describe(
            "Include recently merged PRs (last 30 days) in the scan",
          ),
      }),

      execute: async (
        args: { branch?: string; includeRecent?: boolean },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { repo, teamKeys, apiKey } = context.globalArgs;
        const includeRecent: boolean = args.includeRecent ?? true;

        const states: string = includeRecent ? "--state all" : "--state open";
        const limit: number = includeRecent ? 50 : 30;
        const ghCmd = new Deno.Command("gh", {
          args: [
            "pr",
            "list",
            "--repo",
            repo,
            "--author",
            "@me",
            ...states.split(" "),
            "--limit",
            String(limit),
            "--json",
            "number,title,headRefName,state,isDraft,mergedAt,url,body",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const ghOutput = await ghCmd.output();
        if (!ghOutput.success) {
          const stderr: string = new TextDecoder().decode(ghOutput.stderr);
          throw new Error(`gh pr list failed: ${stderr}`);
        }
        const allPrs: GhPr[] = JSON.parse(
          new TextDecoder().decode(ghOutput.stdout),
        );

        let prs: GhPr[] = allPrs.filter(
          (pr) => pr.state === "OPEN" || pr.state === "MERGED",
        );

        if (args.branch) {
          const stackBranches: string[] = await getStackBranches(
            context.globalArgs.repoPath,
            args.branch,
          );
          if (stackBranches.length > 0) {
            const branchSet: Set<string> = new Set(stackBranches);
            prs = prs.filter((pr) => branchSet.has(pr.headRefName));
            context.logger.info(
              "Filtered to stack: {count} PRs from branch {branch}",
              { count: prs.length, branch: args.branch },
            );
          }
        }

        const prSummaries: z.infer<typeof PrSummarySchema>[] = prs.map(
          (pr) => ({
            number: pr.number,
            title: pr.title,
            headRefName: pr.headRefName,
            state: pr.state as "OPEN" | "MERGED" | "CLOSED",
            isDraft: pr.isDraft,
            mergedAt: pr.mergedAt,
            url: pr.url,
            linearIds: extractLinearIds(pr.body ?? "", teamKeys),
          }),
        );

        const allLinearIds: string[] = [
          ...new Set(prSummaries.flatMap((pr) => pr.linearIds)),
        ];
        context.logger.info(
          "Found {prCount} PRs referencing {linearCount} Linear issues",
          { prCount: prSummaries.length, linearCount: allLinearIds.length },
        );

        const linearIssues: LinearIssueNode[] = await fetchLinearIssues(
          apiKey,
          allLinearIds,
        );
        const issueMap: Map<string, LinearIssueNode> = new Map(
          linearIssues.map((i) => [i.identifier, i]),
        );

        // Group PRs by Linear issue, then build one pair per issue
        const prsWithoutLinear: z.infer<typeof PrSummarySchema>[] = [];
        const issuePrMap = new Map<
          string,
          z.infer<typeof PrSummarySchema>[]
        >();

        for (const pr of prSummaries) {
          if (pr.linearIds.length === 0) {
            prsWithoutLinear.push(pr);
            continue;
          }
          for (const linearId of pr.linearIds) {
            if (!issuePrMap.has(linearId)) issuePrMap.set(linearId, []);
            issuePrMap.get(linearId)!.push(pr);
          }
        }

        const pairs: z.infer<typeof SyncPairSchema>[] = [];
        for (const [linearId, groupPrs] of issuePrMap) {
          const issue: LinearIssueNode | undefined = issueMap.get(linearId);
          if (!issue) continue;
          const expected: string = expectedStateForIssue(groupPrs);
          pairs.push({
            prs: groupPrs,
            linearIssue: {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              url: issue.url,
              stateName: issue.state.name,
              stateType: issue.state.type,
            },
            currentLinearState: issue.state.name,
            expectedLinearState: expected,
            needsUpdate: issue.state.name !== expected,
          });
        }

        const needsUpdate: z.infer<typeof SyncPairSchema>[] = pairs.filter(
          (p) => p.needsUpdate,
        );
        const summary: string = needsUpdate.length === 0
          ? `All ${pairs.length} issue↔PR groups are in sync.`
          : `${needsUpdate.length} of ${pairs.length} groups need updates:\n` +
            needsUpdate
              .map((p) => {
                const prNums: string = p.prs
                  .map((pr) => `#${pr.number} (${pr.state})`)
                  .join(", ");
                return `  ${p.linearIssue.identifier}: ${p.currentLinearState} → ${p.expectedLinearState} [PRs: ${prNums}]`;
              })
              .join("\n");

        context.logger.info(summary);

        const data: z.infer<typeof ScanResultSchema> = {
          scannedAt: new Date().toISOString(),
          repo,
          prCount: prSummaries.length,
          pairs,
          prsWithoutLinear,
          summary,
        };

        const handle: { name: string } = await context.writeResource(
          "scan_result",
          `scan-${new Date().toISOString().slice(0, 10)}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    true_up: {
      description:
        "Transition Linear issues to match their linked PR states. Reads the latest scan_result and applies state changes. Only transitions issues that need updating. Defaults to dry-run mode.",
      arguments: z.object({
        dryRun: z
          .boolean()
          .default(true)
          .describe(
            "Preview changes without applying them. Set to false to actually transition issues.",
          ),
      }),

      execute: async (
        args: { dryRun?: boolean },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { apiKey, teamKeys } = context.globalArgs;
        const dryRun: boolean = args.dryRun ?? true;

        const today: string = new Date().toISOString().slice(0, 10);
        const scanData: Record<string, unknown> | null = await context
          .readResource!(`scan-${today}`);
        if (!scanData) {
          throw new Error(
            `No scan_result found for ${today}. Run scan_stack first.`,
          );
        }
        const scan = scanData as unknown as z.infer<typeof ScanResultSchema>;
        const needsUpdate: z.infer<typeof SyncPairSchema>[] = scan.pairs.filter(
          (p) => p.needsUpdate,
        );

        if (needsUpdate.length === 0) {
          context.logger.info("Nothing to update — all pairs in sync.");
          const result: z.infer<typeof TrueUpResultSchema> = {
            executedAt: new Date().toISOString(),
            transitions: [],
            summary: "All pairs already in sync. No transitions needed.",
          };
          const handle: { name: string } = await context.writeResource(
            "true_up_result",
            `trueup-${today}`,
            result,
          );
          return { dataHandles: [handle] };
        }

        const primaryTeam: string = teamKeys[0];
        const states: WorkflowStateNode[] = await fetchTeamStates(
          apiKey,
          primaryTeam,
        );
        const stateByName: Map<string, WorkflowStateNode> = new Map(
          states.map((s) => [s.name, s]),
        );

        const transitions: z.infer<typeof TrueUpResultSchema>["transitions"] =
          [];

        for (const pair of needsUpdate) {
          const targetState: WorkflowStateNode | undefined = stateByName.get(
            pair.expectedLinearState,
          );
          if (!targetState) {
            transitions.push({
              identifier: pair.linearIssue.identifier,
              from: pair.currentLinearState,
              to: pair.expectedLinearState,
              success: false,
              error:
                `No workflow state named "${pair.expectedLinearState}" found in team ${primaryTeam}`,
            });
            continue;
          }

          if (dryRun) {
            context.logger.info("[DRY RUN] {id}: {from} → {to}", {
              id: pair.linearIssue.identifier,
              from: pair.currentLinearState,
              to: pair.expectedLinearState,
            });
            transitions.push({
              identifier: pair.linearIssue.identifier,
              from: pair.currentLinearState,
              to: pair.expectedLinearState,
              success: true,
              error: null,
            });
            continue;
          }

          try {
            await transitionIssue(apiKey, pair.linearIssue.id, targetState.id);
            context.logger.info("{id}: {from} → {to}", {
              id: pair.linearIssue.identifier,
              from: pair.currentLinearState,
              to: pair.expectedLinearState,
            });
            transitions.push({
              identifier: pair.linearIssue.identifier,
              from: pair.currentLinearState,
              to: pair.expectedLinearState,
              success: true,
              error: null,
            });
          } catch (err) {
            const msg: string = err instanceof Error
              ? err.message
              : String(err);
            context.logger.error("Failed to transition {id}: {error}", {
              id: pair.linearIssue.identifier,
              error: msg,
            });
            transitions.push({
              identifier: pair.linearIssue.identifier,
              from: pair.currentLinearState,
              to: pair.expectedLinearState,
              success: false,
              error: msg,
            });
          }
        }

        const succeeded: number = transitions.filter((t) => t.success).length;
        const failed: number = transitions.filter((t) => !t.success).length;
        const prefix: string = dryRun ? "[DRY RUN] " : "";
        const trSummary: string = `${prefix}${succeeded} transitions${
          failed > 0 ? `, ${failed} failed` : ""
        }`;

        context.logger.info(trSummary);

        const result: z.infer<typeof TrueUpResultSchema> = {
          executedAt: new Date().toISOString(),
          transitions,
          summary: trSummary,
        };

        const handle: { name: string } = await context.writeResource(
          "true_up_result",
          `trueup-${today}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// =============================================================================
// Graphite stack detection
// =============================================================================

/**
 * Get all branch names in a Graphite stack by parsing `gt log short` output.
 *
 * Falls back to an empty array if `gt` is unavailable or the branch isn't in
 * a stack. This makes Graphite optional — the model works with plain GitHub PRs.
 *
 * @param repoPath - Local filesystem path to the git repo.
 * @param _branch - Branch name (used for future per-branch filtering).
 * @returns Array of branch names in the stack.
 */
async function getStackBranches(
  repoPath: string,
  _branch: string,
): Promise<string[]> {
  try {
    const cmd = new Deno.Command("gt", {
      args: ["log", "short", "--cwd", repoPath],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (!output.success) return [];

    const text: string = new TextDecoder().decode(output.stdout);
    const branches: string[] = [];
    for (const line of text.split("\n")) {
      const trimmed: string = line.replace(/[│◯◉─┴┘\s]/g, "").trim();
      if (trimmed && trimmed !== "master" && trimmed !== "main") {
        const branchName: string = trimmed.replace(/\(.*\)$/, "").trim();
        if (branchName) branches.push(branchName);
      }
    }
    return branches;
  } catch {
    return [];
  }
}
