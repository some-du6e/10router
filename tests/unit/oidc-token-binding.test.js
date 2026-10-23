import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
const { verifyOidcIdToken } = await import("../../src/lib/auth/oidc.js");

const issuer = "https://idp.example.com";
const audience = "dashboard-client";
let server;
let privateKey;
let jwksUri;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "RS256" };
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${server.address().port}/jwks`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function verify(claims, expectedNonce = "login-nonce") {
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return verifyOidcIdToken({ idToken, issuer, audience, jwksUri, nonce: expectedNonce });
}

describe("OIDC ID token binding with real signatures and JWKS", () => {
  it("accepts a valid token bound to this login", async () => {
    const payload = await verify({ nonce: "login-nonce" });
    expect(payload.sub).toBe("user-123");
    expect(payload.nonce).toBe("login-nonce");
  });

  it("rejects a signed token from another login", async () => {
    await expect(verify({ nonce: "another-login" })).rejects.toThrow(/nonce mismatch/i);
  });

  it("rejects a signed token missing its nonce", async () => {
    await expect(verify({})).rejects.toThrow(/nonce mismatch/i);
  });

  it("rejects verification without stored login nonce", async () => {
    await expect(verify({ nonce: "login-nonce" }, "")).rejects.toThrow(/Missing OIDC nonce/);
  });
});
