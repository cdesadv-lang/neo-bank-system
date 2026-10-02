import { issueOtp, verifyOtp } from "@/server/auth/otp";

/**
 * 3-D Secure adapter (issuer ACS). Production: EMV 3DS 2.x ACS from a certified provider
 * (frictionless risk-based flow + challenge). The mock performs an OTP challenge to the
 * cardholder's registered mobile through the pluggable OTP provider.
 */
export interface ThreeDsAdapter {
  name: string;
  isMock: boolean;
  challenge(input: { cardId: string; phone: string; merchantName: string; amount: string; currency: string }): Promise<{ challengeId: string; devCode?: string }>;
  verify(cardId: string, challengeId: string, code: string): Promise<boolean>;
}

export const MockThreeDs: ThreeDsAdapter = {
  name: "MOCK_3DS_OTP",
  isMock: true,
  async challenge({ cardId, phone, merchantName, amount, currency }) {
    const r = await issueOtp({ subject: `card:${cardId}`, phone, purpose: "3DS", payload: { merchantName, amount, currency } });
    return { challengeId: r.challengeId, devCode: r.devCode };
  },
  async verify(cardId, challengeId, code) {
    try {
      await verifyOtp(challengeId, `card:${cardId}`, "3DS", code);
      return true;
    } catch {
      return false;
    }
  },
};

export function getThreeDs(): ThreeDsAdapter {
  return MockThreeDs;
}
