// Where a new free-pi user should land, and the attribution free-pi accepts.
//
// The invite link is ours to give away: `https://freepi.ai/?ref=gghg7ytd`. It is
// not a secret, but it IS a business fact, so it lives in one constant and can
// be replaced with `QRONOS_FREEPI_INVITE` without shipping a new version —
// the same rule we keep for every hardcoded value that may change.
//
// free-pi's own client validates these two fields strictly:
//   signup_src    ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$
//   referral_code ^[a-zA-Z0-9][a-zA-Z0-9_-]{3,31}$
// A value that fails the pattern is dropped, never sent half-right.

export const FREEPI_INVITE_URL = "https://freepi.ai/?ref=gghg7ytd";

/** The value free-pi records as "came from the Qronos CLI". */
export const FREEPI_SIGNUP_SRC = "qronos-cli";

const SIGNUP_SRC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const REFERRAL_CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{3,31}$/;

export interface FreepiAttribution {
  signupSrc?: string;
  referralCode?: string;
}

export function isSignupSrc(value: string | undefined): boolean {
  return value !== undefined && SIGNUP_SRC_PATTERN.test(value);
}

export function isReferralCode(value: string | undefined): boolean {
  return value !== undefined && REFERRAL_CODE_PATTERN.test(value);
}

/**
 * Pull `ref=` out of an invite link.
 *
 * Anything malformed is undefined: a made-up referral code is worse than none,
 * and free-pi would refuse it anyway.
 */
export function parseInviteLink(link: string | undefined): FreepiAttribution {
  if (!link || link.trim() === "") return {};
  try {
    const url = new URL(link.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return {};
    const ref = url.searchParams.get("ref") ?? url.searchParams.get("referral") ?? undefined;
    return isReferralCode(ref) ? { referralCode: ref } : {};
  } catch {
    return {};
  }
}

/** The invite link in use: the environment wins, so it can change between releases. */
export function inviteUrlFrom(env: Record<string, string | undefined> = process.env): string {
  const override = env.QRONOS_FREEPI_INVITE?.trim();
  if (override && override !== "") return override;
  return FREEPI_INVITE_URL;
}

/** What the CLI sends to free-pi alongside the consent it already shows. */
export function cliAttribution(env: Record<string, string | undefined> = process.env): FreepiAttribution {
  const { referralCode } = parseInviteLink(inviteUrlFrom(env));
  return { signupSrc: FREEPI_SIGNUP_SRC, ...(referralCode ? { referralCode } : {}) };
}
