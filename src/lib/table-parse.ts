/**
 * ===========================================================================
 * TABLE READING
 * ===========================================================================
 *
 * The mechanics shared by every "paste a spreadsheet at it" flow: splitting a
 * line into cells, and working out which character was separating them.
 *
 * Two features read tables — the BOM import and the catalogue import — and they
 * ask different questions of the result (one wants quantities, the other wants
 * eight text columns). What they must not disagree about is what a *cell* is:
 * a part called `Resistor, 10k 1%` has to survive both, and a delimiter guessed
 * one way here and another way there would mean a file that imports cleanly on
 * one screen and arrives mangled on the other.
 * ===========================================================================
 */

export type DelimiterName = "comma" | "tab" | "semicolon" | "pipe";

const DELIMITERS: Record<DelimiterName, string> = {
  comma: ",",
  tab: "\t",
  semicolon: ";",
  pipe: "|",
};

/**
 * Splits one line, honouring double quotes.
 *
 * Needed because a part called `Resistor, 10k 1%` is entirely ordinary and a
 * naive `split(",")` turns it into two columns and a wrong quantity. A doubled
 * quote inside a quoted field is a literal quote, as every spreadsheet writes it.
 */
export function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Picks the delimiter by consistency, not by frequency.
 *
 * Frequency alone picks the wrong one constantly: a description column full of
 * commas beats the tabs that actually separate the columns. A real delimiter
 * appears the *same number of times on every line*, so the candidate with the
 * steadiest count wins, and ties break toward the most columns.
 */
export function detectDelimiter(lines: string[]): DelimiterName {
  let best: DelimiterName = "comma";
  let bestScore = -1;

  for (const [name, char] of Object.entries(DELIMITERS) as Array<
    [DelimiterName, string]
  >) {
    const counts = lines.map((line) => splitLine(line, char).length);
    const columns = counts[0] ?? 1;
    if (columns < 2) continue;

    const consistent = counts.filter((count) => count === columns).length;
    const score = consistent / counts.length + columns / 1000;

    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

  return best;
}

/** Column headings, reduced to letters and digits so `Part No.` matches `partno`. */
export function normaliseHeading(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export type ReadTable = {
  /** Non-blank input lines, in order, exactly as they arrived. */
  lines: string[];
  /** Those lines split into cells. */
  table: string[][];
  delimiter: DelimiterName;
};

/** Normalises line endings, drops blank lines, and splits into cells. */
export function readTable(input: string): ReadTable {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    return { lines, table: [], delimiter: "comma" };
  }

  const delimiter = detectDelimiter(lines);
  const char = DELIMITERS[delimiter];

  return { lines, table: lines.map((line) => splitLine(line, char)), delimiter };
}

/** True for a cell that is nothing but a number — never a part identifier. */
export function isNumericCell(cell: string): boolean {
  return cell !== "" && /^[\d.,\s]+$/.test(cell);
}
