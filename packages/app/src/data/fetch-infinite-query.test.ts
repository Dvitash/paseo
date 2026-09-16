import { expect, test } from "vitest";
import { fetchInfiniteQueryOptions } from "./query";

const input = {
  queryKey: ["saved", "agent"],
  queryFn: async () => ({ entries: ["message"] }),
  initialPageParam: undefined,
  getNextPageParam: () => undefined,
  staleTimeMs: 60_000,
};

test("paginated fetches use finite freshness and never carry another chat's placeholder data", () => {
  const options = fetchInfiniteQueryOptions(input);
  expect(options.staleTime).toBe(60_000);
  expect(options.refetchOnMount).toBe("always");
  expect(options.meta).toMatchObject({ serverDataPolicy: { class: "fetch", dataShape: "list" } });
  expect(options.placeholderData).toBeUndefined();
});

test("paginated fetches cannot opt out of freshness without a push event", () => {
  expect(() => fetchInfiniteQueryOptions({ ...input, staleTimeMs: Infinity })).toThrow(
    "finite staleTimeMs",
  );
});
