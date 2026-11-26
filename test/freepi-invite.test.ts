// The invite link and the attribution free-pi allows.
import { describe, expect, test } from "bun:test";
import {
  FREEPI_INVITE_URL,
  FREEPI_SIGNUP_SRC,
  cliAttribution,
  inviteUrlFrom,
  isReferralCode,
  isSignupSrc,
  parseInviteLink,
} from "../src/freepi-invite";

describe("parseInviteLink", () => {
  test("the owner's link gives its referral code", () => {
    expect(parseInviteLink("https://freepi.ai/?ref=gghg7ytd")).toEqual({ referralCode: "gghg7ytd" });
  });

  test("`referral` is accepted as well as `ref`", () => {
    expect(parseInviteLink("https://freepi.ai/?referral=abcd1234")).toEqual({ referralCode: "abcd1234" });
  });

  test("a code too short, too long or with the wrong characters is dropped", () => {
    expect(parseInviteLink("https://freepi.ai/?ref=ab")).toEqual({});
    expect(parseInviteLink(`https://freepi.ai/?ref=${"a".repeat(40)}`)).toEqual({});
    expect(parseInviteLink("https://freepi.ai/?ref=bad%20code!")).toEqual({});
  });

  test("no link, a broken link, or a non-http link gives nothing", () => {
    expect(parseInviteLink(undefined)).toEqual({});
    expect(parseInviteLink("")).toEqual({});
    expect(parseInviteLink("not a url")).toEqual({});
    expect(parseInviteLink("javascript:alert(1)")).toEqual({});
  });

  test("a link with no ref is fine, it just attributes nothing", () => {
    expect(parseInviteLink("https://freepi.ai/")).toEqual({});
  });
});

describe("patterns", () => {
  test("signup_src and referral_code follow free-pi's own rules", () => {
    expect(isSignupSrc("qronos-cli")).toBe(true);
    expect(isSignupSrc("bad code")).toBe(false);
    expect(isReferralCode("gghg7ytd")).toBe(true);
    expect(isReferralCode("ab")).toBe(false);
  });
});

describe("inviteUrlFrom", () => {
  test("the built-in link by default", () => {
    expect(inviteUrlFrom({})).toBe(FREEPI_INVITE_URL);
    expect(FREEPI_INVITE_URL).toContain("ref=gghg7ytd");
  });

  test("the environment wins, so the link can change without a release", () => {
    expect(inviteUrlFrom({ QRONOS_FREEPI_INVITE: "https://freepi.ai/?ref=other123" })).toBe(
      "https://freepi.ai/?ref=other123",
    );
  });

  test("an empty override does not wipe the link", () => {
    expect(inviteUrlFrom({ QRONOS_FREEPI_INVITE: "   " })).toBe(FREEPI_INVITE_URL);
  });
});

describe("cliAttribution", () => {
  test("says the CLI sent them, with the link's code", () => {
    expect(cliAttribution({})).toEqual({ signupSrc: FREEPI_SIGNUP_SRC, referralCode: "gghg7ytd" });
  });

  test("with no usable code, only the signup source is sent", () => {
    expect(cliAttribution({ QRONOS_FREEPI_INVITE: "https://freepi.ai/" })).toEqual({ signupSrc: FREEPI_SIGNUP_SRC });
  });
});
