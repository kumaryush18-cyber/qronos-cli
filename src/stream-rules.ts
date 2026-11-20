// Time-traveling stream rules (TTSR), ported in spirit from can1357/oh-my-pi.
//
// Why this exists. Some rules are cheap to state but expensive to send on every
// request: "never use eval()", "never drop the tenant filter", "never write
// dangerouslySetInnerHTML". If a rule sits in the system prompt we pay for it on
// every single turn. If it is missing, the model only learns about it after it
// has already written the bad line.
//
// A stream rule is a regex plus a message. While the assistant streams we test
// the partial text. On a match we stop the stream (the extension does that) and
// attach the rule text to the NEXT request as a system section. The model reads
// the rule at the exact moment it broke it, and the rule costs tokens once.
//
// Deliberately smaller than oh-my-pi: no rule DAG, no per-agent globs, no
// prose/tool split, no repeat policies beyond "once per turn". Rules are read
// from JSON so a project can commit them:
//
//   .qronos/stream-rules.json      (project, committable)
//   ~/.qronos/stream-rules.json    (user, local)
//
// Shape (array, or { "rules": [...] }):
//   [
//     { "name": "no-eval", "pattern": "\\beval\\s*\\(",
//       "message": "Never call eval(). Parse with JSON.parse or a real parser." }
//   ]
//
// All pure logic lives here so it can be tested without a terminal.

export interface RawStreamRule {
  name?: unknown;
  pattern?: unknown;
  message?: unknown;
  flags?: unknown;
  disabled?: unknown;
}

export interface StreamRule {
  /** Stable id used for de-duplication and for disabled-rule lists. */
  name: string;
  /** Compiled pattern. Never carries the `g` flag, so `lastIndex` cannot leak. */
  regex: RegExp;
  /** Text handed back to the model when the rule fires. */
  message: string;
}

export interface ParsedStreamRules {
  rules: StreamRule[];
  /** Human-readable problems, printed once at startup. Never fatal. */
  warnings: string[];
}

/** Default flags: case-insensitive, dot does not cross newlines. */
const DEFAULT_FLAGS = "i";

/** Characters of already-scanned text re-checked on the next chunk. */
export const OVERLAP_CHARS = 200;

/**
 * Turn user JSON into usable rules. Anything malformed becomes a warning and is
 * dropped: a broken rule file must never stop the CLI from starting.
 */
export function parseStreamRules(raw: unknown, disabled: readonly string[] = []): ParsedStreamRules {
  const warnings: string[] = [];
  let entries: unknown[] = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules)) {
    entries = (raw as { rules: unknown[] }).rules;
  } else if (raw === undefined || raw === null) {
    return { rules: [], warnings };
  } else {
    return { rules: [], warnings: ['stream rules: expected an array or { "rules": [...] }'] };
  }

  const dropped = new Set(disabled.map((name) => name.trim()).filter(Boolean));
  const seen = new Set<string>();
  const rules: StreamRule[] = [];

  entries.forEach((entry, index) => {
    const item = (entry ?? {}) as RawStreamRule;
    if (item.disabled === true) return;

    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `rule-${index + 1}`;
    if (item.name !== undefined && typeof item.name !== "string") {
      warnings.push(`stream rules: ${name}: "name" must be a string`);
    }
    if (dropped.has(name)) return;
    if (seen.has(name)) {
      warnings.push(`stream rules: duplicate name "${name}" ignored`);
      return;
    }

    const pattern = typeof item.pattern === "string" ? item.pattern : "";
    if (!pattern) {
      warnings.push(`stream rules: ${name}: missing "pattern"`);
      return;
    }
    const message =
      typeof item.message === "string" && item.message.trim()
        ? item.message.trim()
        : `Do not write code that matches /${pattern}/.`;

    const flags = typeof item.flags === "string" ? item.flags : DEFAULT_FLAGS;
    let regex: RegExp;
    try {
      // `g`/`y` would make regex.test() stateful across chunks; drop them.
      regex = new RegExp(pattern, flags.replace(/[gy]/g, ""));
    } catch (error) {
      warnings.push(`stream rules: ${name}: invalid pattern (${(error as Error).message})`);
      return;
    }

    seen.add(name);
    rules.push({ name, regex, message });
  });

  return { rules, warnings };
}

/**
 * Watches accumulated assistant text for rule matches.
 *
 * The caller passes the FULL text so far (pi sends the whole partial message),
 * and the watcher only scans the new tail plus a small overlap window, so a
 * pattern that spans two chunks is still caught and nothing is scanned twice
 * for no reason.
 */
export class StreamRuleWatcher {
  private readonly rules: StreamRule[];
  private scanned = 0;
  private readonly fired = new Set<string>();

  constructor(rules: readonly StreamRule[]) {
    this.rules = [...rules];
  }

  /** Rules that fired since the last reset, in firing order. */
  firedNames(): string[] {
    return [...this.fired];
  }

  /** Forget every match. Called when a new turn starts. */
  reset(): void {
    this.scanned = 0;
    this.fired.clear();
  }

  /** Only rules that have not fired yet in this turn. */
  private active(): StreamRule[] {
    return this.rules.filter((rule) => !this.fired.has(rule.name));
  }

  /**
   * Feed the full text so far. Returns the first rule that fires now, or null.
   * A rule fires at most once per turn, so a stray repeat cannot loop the model.
   */
  push(text: string): StreamRule | null {
    const active = this.active();
    if (active.length === 0 || text.length === 0) {
      this.scanned = Math.max(this.scanned, text.length);
      return null;
    }

    const start = Math.max(0, this.scanned - OVERLAP_CHARS);
    const window = text.slice(start);
    this.scanned = text.length;

    for (const rule of active) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(window)) {
        this.fired.add(rule.name);
        return rule;
      }
    }
    return null;
  }
}

/** One-line notice for the transcript / status line. */
export function ruleNotice(rule: StreamRule): string {
  return `✻ stream rule "${rule.name}" stopped this turn`;
}

/**
 * The text injected as a system section on the next request. Short on purpose:
 * it must read as a correction, not as a new policy document.
 */
export function formatRuleReminder(rule: StreamRule): string {
  return [
    `<stream-rule name="${rule.name}">`,
    `Your previous reply was stopped mid-stream because it matched this rule: /${rule.regex.source}/`,
    rule.message,
    `Rewrite the affected part. Do not repeat the pattern, and do not mention this note to the user.`,
    `</stream-rule>`,
  ].join("\n");
}

/** Section key used in the system prompt, so a later rule replaces the earlier one. */
export const STREAM_RULES_SECTION = "stream-rule";
