import { describe, expect, it } from "vitest";
import { agentProviders, listAgents } from "../agents";
import { NO_RECIPE, RECIPES } from "./recipes";

/** Every routable catalogue entry, keyed the way recipes are named. */
function catalogueEntries(): string[] {
  return listAgents()
    .filter((agent) => agent.supported)
    .flatMap((agent) =>
      agent.alwaysCustom
        ? [agent.id]
        : agentProviders(agent.id).map((p) => `${agent.id}/${p.id}`)
    );
}

describe("e2e coverage", () => {
  it("gives every catalogue entry a recipe, or a reason it has none", () => {
    const covered = new Set([
      ...RECIPES.map((r) => r.name),
      ...Object.keys(NO_RECIPE),
    ]);
    expect(catalogueEntries().filter((entry) => !covered.has(entry))).toEqual(
      []
    );
  });

  it("names no entry the catalogue does not have", () => {
    const entries = new Set(catalogueEntries());
    const named = [...RECIPES.map((r) => r.name), ...Object.keys(NO_RECIPE)];
    expect(named.filter((name) => !entries.has(name))).toEqual([]);
  });

  it("never gives an entry both a recipe and a reason", () => {
    expect(
      RECIPES.map((r) => r.name).filter((name) => name in NO_RECIPE)
    ).toEqual([]);
  });

  it("names each recipe after the choice it drives", () => {
    for (const recipe of RECIPES) {
      const { agent, provider } = recipe.choice;
      expect(recipe.name).toBe(provider ? `${agent}/${provider}` : agent);
    }
  });
});
