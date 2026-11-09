import { z } from "zod";

// Client-only configuration.
//
// The free-pi SERVER owns all economic and abuse-control tuning — the daily
// spend caps, the account tiers, the rate ceilings and the abuse classifier
// thresholds. None of that lives in the client, and none of it is published
// here. The terminal ad extension needs exactly two display knobs, and both
// have safe public defaults, so this is the whole of the client config
// surface.

export const ConfigSchema = z.object({
  // Show the inline ad card after assistant turns.
  adInlineTurnFrequency: z.number().int().default(1),
  // Minimum terminal width (columns) for the framed ad card.
  adMinColumns: z.number().int().default(35),
});

export type Config = z.infer<typeof ConfigSchema>;

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return ConfigSchema.parse({
    adInlineTurnFrequency: envNumber(env.AD_INLINE_TURN_FREQUENCY),
    adMinColumns: envNumber(env.AD_MIN_COLUMNS),
  });
}
