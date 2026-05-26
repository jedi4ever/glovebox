import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

// End-to-end tests for msb's TLS interception.
//
// The fixture turns on:
//   tls_intercept: true   → msb's built-in TLS MITM proxy
//   trust_host_cas: true  → ship host's CA bundle into the guest
//
// We assert two things:
// 1. Functional: an outbound HTTPS call still works (the proxy doesn't
//    break legitimate traffic).
// 2. Effective: the server cert the guest sees is signed by msb's own
//    CA — proving the proxy is actually in-path. Without `tls_intercept`
//    the issuer would be the real upstream CA (Let's Encrypt, Cloudflare,
//    DigiCert, etc.). With interception, it's `microsandbox CA`.
//
// buildpack-deps:noble has curl and openssl preinstalled.

describe("tls interception integration", () => {
  it("curl https:// still succeeds through the MITM proxy", async () => {
    const { session, teardown } = await setupScenario("glovebox-tls-curl-", {
      fixture: "config-tls",
    });
    try {
      const result = await session.run(
        "Use Bash to run `curl -sSL https://example.com` and tell me whether 'Example Domain' appears verbatim in the body."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Example Domain/);
    } finally {
      await teardown();
    }
  });

  it("server cert issuer becomes 'microsandbox CA' — proving the MITM is in-path", async () => {
    const { session, teardown } = await setupScenario("glovebox-tls-issuer-", {
      fixture: "config-tls",
    });
    try {
      const result = await session.run(
        "Run this exact bash command and report the output verbatim, no commentary: " +
        "`echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -issuer`"
      );
      expect(result.exitCode).toBe(0);
      // With TLS interception on, the issuer is msb's CA, not Cloudflare/Let's Encrypt/etc.
      expect(result.stdout).toMatch(/microsandbox/i);
    } finally {
      await teardown();
    }
  });
});
