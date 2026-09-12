// Formatting is presentation-only; never feed this text back into an eval input.
export const MAX_EVAL_FORMAT_CHARS = 20_000;

function parserForLanguage(language: string | null): "babel" | "babel-ts" | null {
  switch (language) {
    case "js":
    case "javascript":
    case "jsx":
      return "babel";
    case "ts":
    case "typescript":
    case "tsx":
      return "babel-ts";
    default:
      return null;
  }
}

export function canFormatEvalCode(code: string, language: string | null): boolean {
  return (
    code.length > 0 && code.length <= MAX_EVAL_FORMAT_CHARS && parserForLanguage(language) !== null
  );
}

export async function formatEvalCode(code: string, language: string | null): Promise<string> {
  if (!canFormatEvalCode(code, language)) return code;
  const parser = parserForLanguage(language);
  if (!parser) return code;

  try {
    const [prettier, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);
    return await prettier.format(code, {
      parser,
      plugins: [babel, estree],
      printWidth: 80,
      tabWidth: 2,
      embeddedLanguageFormatting: "off",
    });
  } catch {
    // A partial/invalid eval must remain readable even when it cannot be parsed.
    return code;
  }
}
