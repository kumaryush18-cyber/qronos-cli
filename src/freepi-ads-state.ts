// "free-pi says it is not counting impressions."
//
// One flag for the whole process, written by the ad code and read by
// `qronos freepi list`. It is a one-way mirror of what the server told us — no
// guessing, and no hiding: a user whose allowance stops needs a sentence that
// explains why, not silence.
let adsRequired = false;

export function setFreepiAdsRequired(value: boolean): void {
  adsRequired = value;
}

export function freepiAdsRequired(): boolean {
  return adsRequired;
}

/** Tests only: forget the last answer. */
export function resetFreepiAdsState(): void {
  adsRequired = false;
}
