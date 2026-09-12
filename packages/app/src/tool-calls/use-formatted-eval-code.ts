import { useFetchQuery } from "@/data/query";
import { queryClient } from "@/data/query-client";
import { canFormatEvalCode, formatEvalCode } from "./eval-format";

export function useFormattedEvalCode(code: string, language: string | null): string {
  const enabled = canFormatEvalCode(code, language);
  const queryKey = ["eval-display-format", language, enabled ? code : null] as const;
  const result = useFetchQuery(
    {
      queryKey,
      queryFn: () => queryClient.getQueryData<string>(queryKey) ?? formatEvalCode(code, language),
      enabled,
      dataShape: "value",
      staleTimeMs: 60_000,
      gcTime: 60_000,
      retry: false,
    },
    queryClient,
  );
  return enabled ? (result.data ?? code) : code;
}
