import { renderToString } from "katex";

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
  x: "ˣ",
  y: "ʸ",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  "∘": "°",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

function cleanHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Converts a LaTeX math formula into clean, readable Unicode text for
 * native mobile surfaces where full HTML/CSS typography is unavailable.
 */
export function formatLatexToReadableText(latex: string): string {
  const trimmed = latex.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const mathml = renderToString(trimmed, {
      output: "mathml",
      throwOnError: false,
    });

    let text = mathml.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, "");

    // Fractions: <mfrac>...<mrow>...</mrow><mrow>...</mrow>...</mfrac>
    text = text.replace(/<mfrac>([\s\S]*?)<\/mfrac>/g, (_, inner: string) => {
      const parts = inner.match(/<mrow>[\s\S]*?<\/mrow>|<m[a-z]+[^>]*>[\s\S]*?<\/m[a-z]+>/g) ?? [];
      if (parts.length === 2 && parts[0] && parts[1]) {
        const num = cleanHtmlTags(parts[0]);
        const den = cleanHtmlTags(parts[1]);
        return `${num}/${den}`;
      }
      return inner;
    });

    // Superscripts: <msup><base>...</base><sup/></msup>
    text = text.replace(
      /<msup>\s*<m[a-z]+[^>]*>([\s\S]*?)<\/m[a-z]+>\s*<m[a-z]+[^>]*>([\s\S]*?)<\/m[a-z]+>\s*<\/msup>/g,
      (_, base: string, sup: string) => {
        const b = cleanHtmlTags(base);
        const s = cleanHtmlTags(sup);
        if (s === "∘") {
          return `${b}°`;
        }
        if (SUPERSCRIPTS[s]) {
          return `${b}${SUPERSCRIPTS[s]}`;
        }
        return `${b}^${s}`;
      },
    );

    // Subscripts: <msub><base>...</base><sub/></msub>
    text = text.replace(
      /<msub>\s*<m[a-z]+[^>]*>([\s\S]*?)<\/m[a-z]+>\s*<m[a-z]+[^>]*>([\s\S]*?)<\/m[a-z]+>\s*<\/msub>/g,
      (_, base: string, sub: string) => {
        const b = cleanHtmlTags(base);
        const s = cleanHtmlTags(sub);
        if (SUBSCRIPTS[s]) {
          return `${b}${SUBSCRIPTS[s]}`;
        }
        return `${b}_${s}`;
      },
    );

    const cleaned = cleanHtmlTags(text)
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s*\^\s*∘/g, "°");

    return cleaned || trimmed;
  } catch {
    return trimmed;
  }
}
