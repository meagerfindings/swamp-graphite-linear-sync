import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  expectedStateForIssue,
  extractLinearIds,
  getStackBranches,
  type GhRunner,
  GlobalArgsSchema,
  prExpectedState,
  PrSummarySchema,
} from "./graphite_linear_sync.ts";

const pr = (state: "OPEN" | "MERGED" | "CLOSED", isDraft = false) =>
  PrSummarySchema.parse({
    number: 7,
    title: "PR",
    headRefName: "feature",
    state,
    isDraft,
    mergedAt: state === "MERGED" ? "2026-07-16T00:00:00Z" : null,
    url: "https://github.com/acme/repo/pull/7",
    linearIds: ["ENG-7"],
  });

Deno.test("GlobalArgsSchema: accepts a complete configuration", () => {
  const args = {
    apiKey: "lin_api_test",
    teamKeys: ["ENG"],
    repo: "acme/repo",
    repoPath: "/repo",
  };
  assertEquals(GlobalArgsSchema.parse(args), args);
});

Deno.test("GlobalArgsSchema: rejects missing API key and non-array team keys", () => {
  assertThrows(() =>
    GlobalArgsSchema.parse({
      teamKeys: ["ENG"],
      repo: "acme/repo",
      repoPath: "/repo",
    })
  );
  assertThrows(() =>
    GlobalArgsSchema.parse({
      apiKey: "key",
      teamKeys: "ENG",
      repo: "acme/repo",
      repoPath: "/repo",
    })
  );
});

Deno.test("PrSummarySchema: validates the three supported PR states", () => {
  assertEquals(pr("OPEN").state, "OPEN");
  assertEquals(pr("MERGED").state, "MERGED");
  assertEquals(pr("CLOSED").state, "CLOSED");
});

Deno.test("PrSummarySchema: rejects unknown states and malformed identifiers", () => {
  const valid = pr("OPEN");
  assertThrows(() => PrSummarySchema.parse({ ...valid, state: "PENDING" }));
  assertThrows(() => PrSummarySchema.parse({ ...valid, linearIds: [123] }));
});

Deno.test("extractLinearIds: extracts configured teams in encounter order", () => {
  assertEquals(
    extractLinearIds("Fixes ENG-12 and OPS-9; see ENG-13", ["ENG", "OPS"]),
    ["ENG-12", "OPS-9", "ENG-13"],
  );
});

Deno.test("extractLinearIds: deduplicates repeated issue references", () => {
  assertEquals(extractLinearIds("ENG-12, then ENG-12 again", ["ENG"]), [
    "ENG-12",
  ]);
});

Deno.test("extractLinearIds: ignores unconfigured teams and case mismatches", () => {
  assertEquals(extractLinearIds("OPS-1 eng-2 ENG-3", ["ENG"]), ["ENG-3"]);
});

Deno.test("extractLinearIds: handles an empty PR body", () => {
  assertEquals(extractLinearIds("", ["ENG"]), []);
});

Deno.test("prExpectedState: maps merged and closed PRs", () => {
  assertEquals(prExpectedState(pr("MERGED")), "Done");
  assertEquals(prExpectedState(pr("CLOSED")), "Canceled");
});

Deno.test("prExpectedState: maps draft and ready open PRs", () => {
  assertEquals(prExpectedState(pr("OPEN", true)), "In Progress");
  assertEquals(prExpectedState(pr("OPEN", false)), "In Review");
});

Deno.test("expectedStateForIssue: least-progressed active PR gates the issue", () => {
  assertEquals(
    expectedStateForIssue([pr("MERGED"), pr("OPEN"), pr("OPEN", true)]),
    "In Progress",
  );
  assertEquals(expectedStateForIssue([pr("MERGED"), pr("OPEN")]), "In Review");
});

Deno.test("expectedStateForIssue: all merged resolves Done", () => {
  assertEquals(expectedStateForIssue([pr("MERGED"), pr("MERGED")]), "Done");
});

Deno.test("expectedStateForIssue: closed PRs are ignored when active PRs exist", () => {
  assertEquals(expectedStateForIssue([pr("CLOSED"), pr("OPEN")]), "In Review");
});

Deno.test("expectedStateForIssue: only closed PRs resolve Canceled", () => {
  assertEquals(expectedStateForIssue([pr("CLOSED"), pr("CLOSED")]), "Canceled");
});

// GitHub stack scoping. The stack response mirrors GET /repos/{repo}/stacks?pull_request=<n>.
const stackResponse = JSON.stringify([{
  number: 30559,
  base: { ref: "master" },
  pull_requests: [
    { number: 30413, head: { ref: "lin-27-catalog" } },
    { number: 30414, head: { ref: "lin-28-registry" } },
    { number: 30415, head: { ref: "lin-29-transport" } },
  ],
}]);

Deno.test("getStackBranches: returns the whole GitHub stack, bottom to top, for a mid-stack branch", async () => {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    return Promise.resolve(stackResponse);
  };
  const branches = await getStackBranches(
    "acme/repo",
    "lin-28-registry",
    [{ number: 30414, headRefName: "lin-28-registry" }],
    gh,
  );
  assertEquals(branches, [
    "lin-27-catalog",
    "lin-28-registry",
    "lin-29-transport",
  ]);
  assertEquals(calls, [["api", "repos/acme/repo/stacks?pull_request=30414"]]);
});

Deno.test("getStackBranches: an unstacked PR scopes to just its branch", async () => {
  const gh: GhRunner = () => Promise.resolve("[]");
  assertEquals(
    await getStackBranches("acme/repo", "solo", [{
      number: 5,
      headRefName: "solo",
    }], gh),
    ["solo"],
  );
});

Deno.test("getStackBranches: finds a PR missing from the listed PRs with gh pr list --head", async () => {
  const gh: GhRunner = (args) =>
    Promise.resolve(
      args[0] === "pr" ? JSON.stringify([{ number: 30415 }]) : stackResponse,
    );
  assertEquals(
    (await getStackBranches("acme/repo", "lin-29-transport", [], gh)).length,
    3,
  );
});

Deno.test("getStackBranches: API failure or unknown branch leaves the scan unfiltered", async () => {
  const failing: GhRunner = () => Promise.resolve(null);
  assertEquals(
    await getStackBranches(
      "acme/repo",
      "x",
      [{ number: 1, headRefName: "x" }],
      failing,
    ),
    [],
  );
  assertEquals(
    await getStackBranches(
      "acme/repo",
      "missing",
      [],
      () => Promise.resolve("[]"),
    ),
    [],
  );
});
