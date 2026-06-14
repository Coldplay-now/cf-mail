import { describe, expect, it } from "vitest";
import {
  AGENT_OPEN_STATES,
  buildManifest,
  canAck,
  correlationFromLocalPart,
  deriveTrust,
  inboundAdmit,
  isAckResult,
  matchAllow,
  outboundAllowed
} from "../src/agent";
import { snippetOf, threadKeyOf } from "../src/env";

describe("matchAllow", () => {
  it("matches exact addresses case-insensitively", () => {
    expect(matchAllow("Alice@Example.com", ["alice@example.com"])).toBe(true);
    expect(matchAllow("bob@example.com", ["alice@example.com"])).toBe(false);
  });
  it("matches a whole domain via @domain", () => {
    expect(matchAllow("anyone@corp.com", ["@corp.com"])).toBe(true);
    expect(matchAllow("anyone@other.com", ["@corp.com"])).toBe(false);
  });
  it("is default-deny on an empty list", () => {
    expect(matchAllow("a@b.com", [])).toBe(false);
  });
});

describe("inboundAdmit (A2)", () => {
  const base = { inAllow: ["@corp.com"], grants: ["temp@x.com"], isReplyToAgent: false };
  it("admits an allowlisted sender", () => {
    expect(inboundAdmit({ ...base, sender: "p@corp.com" })).toBe(true);
  });
  it("admits a live reply-grant holder", () => {
    expect(inboundAdmit({ ...base, sender: "temp@x.com" })).toBe(true);
  });
  it("admits a reply to the agent", () => {
    expect(inboundAdmit({ ...base, sender: "stranger@y.com", isReplyToAgent: true })).toBe(true);
  });
  it("default-denies everyone else", () => {
    expect(inboundAdmit({ ...base, sender: "stranger@y.com" })).toBe(false);
    expect(inboundAdmit({ sender: "x@y.com", inAllow: [], grants: [], isReplyToAgent: false })).toBe(false);
  });
});

describe("outboundAllowed (A2 egress)", () => {
  it("allows when every recipient is allowlisted", () => {
    const r = outboundAllowed({ recipients: ["a@corp.com", "b@corp.com"], outAllow: ["@corp.com"], replyTargets: [] });
    expect(r.ok).toBe(true);
    expect(r.refused).toEqual([]);
  });
  it("allows a reply target even if not statically listed", () => {
    const r = outboundAllowed({ recipients: ["who@x.com"], outAllow: [], replyTargets: ["who@x.com"] });
    expect(r.ok).toBe(true);
  });
  it("refuses (whole send) if any recipient is disallowed and lists them", () => {
    const r = outboundAllowed({ recipients: ["ok@corp.com", "bad@evil.com"], outAllow: ["@corp.com"], replyTargets: [] });
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual(["bad@evil.com"]);
  });
});

describe("deriveTrust (§6, read-modulation only)", () => {
  const dkim = "dkim=pass header.d=corp.com; spf=pass";
  it("an authenticated reply to the agent is trusted", () => {
    const t = deriveTrust({ authResults: dkim, knownContact: false, allowlisted: false, firstContact: false, isReplyToAgent: true });
    expect(t.trustLevel).toBe("trusted");
    expect(t.dkimPass).toBe(true);
    expect(t.spfPass).toBe(true);
  });
  it("an authenticated allowlisted sender is known", () => {
    const t = deriveTrust({ authResults: dkim, knownContact: false, allowlisted: true, firstContact: false, isReplyToAgent: false });
    expect(t.trustLevel).toBe("known");
  });
  it("an authenticated saved contact is known", () => {
    const t = deriveTrust({ authResults: dkim, knownContact: true, allowlisted: false, firstContact: false, isReplyToAgent: false });
    expect(t.trustLevel).toBe("known");
  });
  it("first-contact / no DKIM is unknown", () => {
    const t = deriveTrust({ authResults: "dkim=fail", knownContact: false, allowlisted: true, firstContact: true, isReplyToAgent: false });
    expect(t.trustLevel).toBe("unknown");
    expect(t.dkimPass).toBe(false);
  });
});

describe("correlationFromLocalPart", () => {
  it("extracts the plus tag", () => {
    expect(correlationFromLocalPart("agent+task123")).toBe("task123");
  });
  it("returns null without a plus tag", () => {
    expect(correlationFromLocalPart("agent")).toBeNull();
    expect(correlationFromLocalPart("agent+")).toBeNull();
  });
});

describe("ack lifecycle (§5)", () => {
  it("only open mail can be acked", () => {
    for (const s of AGENT_OPEN_STATES) expect(canAck(s)).toBe(true);
    expect(canAck("handled")).toBe(false);
    expect(canAck("failed")).toBe(false);
    expect(canAck(null)).toBe(false);
  });
  it("validates the result vocabulary", () => {
    expect(isAckResult("done")).toBe(true);
    expect(isAckResult("escalated")).toBe(true);
    expect(isAckResult("rejected")).toBe(true);
    expect(isAckResult("whatever")).toBe(false);
  });
});

describe("buildManifest (§11.1)", () => {
  it("describes the operations and surfaces the allowlists", () => {
    const m = buildManifest({ address: "agent@x.com", purpose: "demo", inAllow: ["@x.com"], outAllow: ["a@x.com"] });
    expect(m.address).toBe("agent@x.com");
    expect(m.operations.map((o) => o.name).sort()).toEqual(["ack", "events", "inbox", "send"]);
    expect(m.inboundAllowed).toEqual(["@x.com"]);
    expect(m.operations.find((o) => o.name === "inbox")?.path).toBe("/api/agent/agent/inbox");
  });
});

describe("env helpers", () => {
  it("threadKeyOf prefers the first References token, else own message-id", () => {
    expect(threadKeyOf("<root> <mid>", "<self>")).toBe("<root>");
    expect(threadKeyOf(null, "<self>")).toBe("<self>");
    expect(threadKeyOf("", null)).toBeNull();
  });
  it("snippetOf strips tags and collapses whitespace", () => {
    expect(snippetOf("  hello   world ", null)).toBe("hello world");
    expect(snippetOf(null, "<p>hi <b>there</b></p>")).toBe("hi there");
    expect(snippetOf("", null)).toBeNull();
  });
});
