import { describe, expect, test } from "bun:test";
import {
  LESSON_MAX_CHARS,
  LESSON_MAX_ENTRIES,
  addLesson,
  forgetLesson,
  lessonKey,
  parseLessons,
  renderLessons,
  type Lesson,
} from "../src/memory-lessons";

const at = Date.parse("2026-03-04T00:00:00Z");

describe("parseLessons", () => {
  test("an empty file has no lessons", () => {
    expect(parseLessons("")).toEqual([]);
    expect(parseLessons(undefined)).toEqual([]);
  });

  test("reads bullets with and without a date", () => {
    const lessons = parseLessons("# Lessons\n\n- [2026-01-02] dated\n- undated");
    expect(lessons.map((lesson) => lesson.text)).toEqual(["dated", "undated"]);
    expect(lessons[0]!.at).toBe(Date.parse("2026-01-02T00:00:00Z"));
    expect(lessons[1]!.at).toBe(0);
  });

  test("ignores blank lines and headings", () => {
    expect(parseLessons("\n\n# Lessons\n\n\n")).toEqual([]);
  });

  test("round-trips through render", () => {
    const lessons: Lesson[] = [{ at, text: "run the suite with --bail" }];
    expect(parseLessons(renderLessons(lessons))).toEqual(lessons);
  });
});

describe("addLesson", () => {
  test("a new lesson goes to the front", () => {
    const result = addLesson([{ at: 1, text: "old" }], "new", at);
    expect(result.added).toBe(true);
    expect(result.lessons.map((lesson) => lesson.text)).toEqual(["new", "old"]);
  });

  test("an empty lesson is refused", () => {
    const result = addLesson([], "   ", at);
    expect(result.added).toBe(false);
    expect(result.reason).toBe("empty");
  });

  test("a duplicate is refused and reported", () => {
    const first = addLesson([], "Use bun, not npm", at);
    const second = addLesson(first.lessons, "use bun, not npm.", at + 1);
    expect(second.added).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(second.lessons.length).toBe(1);
  });

  test("a secret is redacted before it is stored", () => {
    const result = addLesson([], "the key is AKIAIOSFODNN7EXAMPLE", at);
    expect(result.lessons[0]!.text).not.toContain("AKIA");
  });

  test("a long lesson is clamped", () => {
    const result = addLesson([], "y".repeat(LESSON_MAX_CHARS + 100), at);
    expect(result.lessons[0]!.text.length).toBeLessThanOrEqual(LESSON_MAX_CHARS);
  });

  test("the list is capped and the oldest lesson falls off", () => {
    let lessons: Lesson[] = [];
    for (let i = 0; i < LESSON_MAX_ENTRIES + 3; i += 1) {
      lessons = addLesson(lessons, `lesson ${i}`, at + i).lessons;
    }
    expect(lessons.length).toBe(LESSON_MAX_ENTRIES);
    expect(lessons[0]!.text).toBe(`lesson ${LESSON_MAX_ENTRIES + 2}`);
  });

  test("newlines inside a lesson are flattened", () => {
    expect(addLesson([], "line one\nline two", at).lessons[0]!.text).toBe("line one line two");
  });
});

describe("forgetLesson", () => {
  test("removes the matching lesson only", () => {
    const lessons: Lesson[] = [
      { at, text: "use bun" },
      { at, text: "node 20 only" },
    ];
    const result = forgetLesson(lessons, "bun");
    expect(result.removed).toBe(1);
    expect(result.lessons.map((lesson) => lesson.text)).toEqual(["node 20 only"]);
  });

  test("no match removes nothing", () => {
    expect(forgetLesson([{ at, text: "a" }], "zzz").removed).toBe(0);
  });

  test("an empty search removes nothing", () => {
    expect(forgetLesson([{ at, text: "a" }], "  ").removed).toBe(0);
  });
});

describe("lessonKey", () => {
  test("ignores case, spacing and a trailing stop", () => {
    expect(lessonKey("  Use   Bun. ")).toBe(lessonKey("use bun"));
  });
});
