import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  expectedStateForIssue,
  extractLinearIds,
  GlobalArgsSchema,
  PrSummarySchema,
  prExpectedState,
} from "./graphite_linear_sync.ts";

const pr = (state: "OPEN" | "MERGED" | "CLOSED", isDraft = false) =>
  PrSummarySchema.parse({
    number: 7, title: "PR", headRefName: "feature", state, isDraft,
    mergedAt: state === "MERGED" ? "2026-07-16T00:00:00Z" : null,
    url: "https://github.com/acme/repo/pull/7", linearIds: ["ENG-7"],
  });

Deno.test("GlobalArgsSchema: accepts a complete configuration", () => {
  const args = { apiKey: "lin_api_test", teamKeys: ["ENG"], repo: "acme/repo", repoPath: "/repo" };
  assertEquals(GlobalArgsSchema.parse(args), args);
});

Deno.test("GlobalArgsSchema: rejects missing API key and non-array team keys", () => {
  assertThrows(() => GlobalArgsSchema.parse({ teamKeys: ["ENG"], repo: "acme/repo", repoPath: "/repo" }));
  assertThrows(() => GlobalArgsSchema.parse({ apiKey: "key", teamKeys: "ENG", repo: "acme/repo", repoPath: "/repo" }));
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
  assertEquals(extractLinearIds("Fixes ENG-12 and OPS-9; see ENG-13", ["ENG", "OPS"]), ["ENG-12", "OPS-9", "ENG-13"]);
});

Deno.test("extractLinearIds: deduplicates repeated issue references", () => {
  assertEquals(extractLinearIds("ENG-12, then ENG-12 again", ["ENG"]), ["ENG-12"]);
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
  assertEquals(expectedStateForIssue([pr("MERGED"), pr("OPEN"), pr("OPEN", true)]), "In Progress");
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
