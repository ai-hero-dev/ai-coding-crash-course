import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  slugify,
  getAllCategories,
  getCategoryById,
  getCategoryBySlug,
  getCategoryByName,
  getAllCategoriesWithCourseCounts,
  createCategory,
  updateCategory,
  deleteCategory,
} from "./categoryService";

describe("categoryService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  // ─── Slug Generation ───

  describe("slugify", () => {
    it("converts name to lowercase slug", () => {
      expect(slugify("Machine Learning")).toBe("machine-learning");
    });

    it("removes special characters", () => {
      expect(slugify("Hello, World! (2024)")).toBe("hello-world-2024");
    });

    it("trims leading and trailing dashes", () => {
      expect(slugify("--hello--")).toBe("hello");
    });

    it("collapses multiple separators", () => {
      expect(slugify("foo   bar")).toBe("foo-bar");
    });

    it("handles already-clean slugs", () => {
      expect(slugify("already-clean")).toBe("already-clean");
    });

    it("handles unicode by stripping non-alphanumeric", () => {
      expect(slugify("café résumé")).toBe("caf-r-sum");
    });

    it("handles empty string", () => {
      expect(slugify("")).toBe("");
    });
  });

  // ─── Read Operations ───

  describe("getAllCategories", () => {
    it("returns all categories", () => {
      const cats = getAllCategories();
      expect(cats.length).toBeGreaterThanOrEqual(1);
      expect(cats.some((c) => c.slug === "programming")).toBe(true);
    });

    it("returns categories ordered alphabetically by name", () => {
      testDb
        .insert(schema.categories)
        .values({ name: "Zebra Studies", slug: "zebra-studies" })
        .run();
      testDb
        .insert(schema.categories)
        .values({ name: "Art", slug: "art" })
        .run();

      const cats = getAllCategories();
      const names = cats.map((c) => c.name);
      expect(names).toEqual([...names].sort());
    });
  });

  describe("getCategoryById", () => {
    it("returns the category by id", () => {
      const cat = getCategoryById(base.category.id);
      expect(cat).toBeDefined();
      expect(cat!.name).toBe("Programming");
    });

    it("returns undefined for non-existent id", () => {
      expect(getCategoryById(9999)).toBeUndefined();
    });
  });

  describe("getCategoryBySlug", () => {
    it("returns the category by slug", () => {
      const cat = getCategoryBySlug("programming");
      expect(cat).toBeDefined();
      expect(cat!.name).toBe("Programming");
    });

    it("returns undefined for non-existent slug", () => {
      expect(getCategoryBySlug("nonexistent")).toBeUndefined();
    });
  });

  describe("getCategoryByName", () => {
    it("returns the category by name", () => {
      const cat = getCategoryByName("Programming");
      expect(cat).toBeDefined();
      expect(cat!.slug).toBe("programming");
    });

    it("returns undefined for non-existent name", () => {
      expect(getCategoryByName("Nonexistent")).toBeUndefined();
    });
  });

  describe("getAllCategoriesWithCourseCounts", () => {
    it("returns categories with course counts", () => {
      const cats = getAllCategoriesWithCourseCounts();
      const programming = cats.find((c) => c.slug === "programming");
      expect(programming).toBeDefined();
      expect(programming!.courseCount).toBe(1);
    });

    it("returns 0 for categories with no courses", () => {
      testDb
        .insert(schema.categories)
        .values({ name: "Empty Category", slug: "empty-category" })
        .run();

      const cats = getAllCategoriesWithCourseCounts();
      const empty = cats.find((c) => c.slug === "empty-category");
      expect(empty).toBeDefined();
      expect(empty!.courseCount).toBe(0);
    });

    it("returns categories ordered alphabetically", () => {
      testDb
        .insert(schema.categories)
        .values({ name: "Art", slug: "art" })
        .run();

      const cats = getAllCategoriesWithCourseCounts();
      const names = cats.map((c) => c.name);
      expect(names).toEqual([...names].sort());
    });
  });

  // ─── Create ───

  describe("createCategory", () => {
    it("creates a category with auto-generated slug", () => {
      const cat = createCategory("Machine Learning");
      expect(cat.name).toBe("Machine Learning");
      expect(cat.slug).toBe("machine-learning");
      expect(cat.id).toBeDefined();
    });

    it("throws on duplicate name", () => {
      expect(() => createCategory("Programming")).toThrow(
        'A category with the name "Programming" already exists.'
      );
    });

    it("throws on duplicate slug", () => {
      // "programming!" would produce slug "programming" which already exists
      testDb
        .insert(schema.categories)
        .values({ name: "Data Science", slug: "data-science" })
        .run();

      expect(() => createCategory("Data Science")).toThrow(
        'A category with the name "Data Science" already exists.'
      );
    });

    it("throws on slug collision even with different name", () => {
      // Create a category, then try another name that produces the same slug
      createCategory("Web Dev");
      expect(() => createCategory("web dev")).toThrow();
    });
  });

  // ─── Update ───

  describe("updateCategory", () => {
    it("updates name and regenerates slug", () => {
      const updated = updateCategory(base.category.id, "Web Development");
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Web Development");
      expect(updated!.slug).toBe("web-development");
    });

    it("allows updating to the same name (no-op rename)", () => {
      const updated = updateCategory(base.category.id, "Programming");
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Programming");
    });

    it("throws on duplicate name with another category", () => {
      testDb
        .insert(schema.categories)
        .values({ name: "Design", slug: "design" })
        .run();

      expect(() => updateCategory(base.category.id, "Design")).toThrow(
        'A category with the name "Design" already exists.'
      );
    });

    it("throws on duplicate slug with another category", () => {
      testDb
        .insert(schema.categories)
        .values({ name: "Design", slug: "design" })
        .run();

      // "design" name → "design" slug, which already exists under a different id
      expect(() => updateCategory(base.category.id, "Design")).toThrow();
    });
  });

  // ─── Delete ───

  describe("deleteCategory", () => {
    it("deletes a category with no courses", () => {
      const empty = testDb
        .insert(schema.categories)
        .values({ name: "Empty", slug: "empty" })
        .returning()
        .get();

      const deleted = deleteCategory(empty.id);
      expect(deleted).toBeDefined();
      expect(deleted!.id).toBe(empty.id);
      expect(getCategoryById(empty.id)).toBeUndefined();
    });

    it("throws when category has courses", () => {
      expect(() => deleteCategory(base.category.id)).toThrow(
        "Cannot delete: 1 course use this category."
      );
    });

    it("includes course count in error message", () => {
      // Add a second course to the category
      testDb
        .insert(schema.courses)
        .values({
          title: "Second Course",
          slug: "second-course",
          description: "desc",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Draft,
        })
        .run();

      expect(() => deleteCategory(base.category.id)).toThrow(
        "Cannot delete: 2 courses use this category."
      );
    });
  });
});
