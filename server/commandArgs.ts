export function parseCommandArgs(value?: string) {
  const input = value?.trim();
  if (!input) return [];

  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  const pushCurrent = () => {
    if (!current) return;
    args.push(current);
    current = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (quote === "\"" && char === "\\" && (input[index + 1] === "\"" || input[index + 1] === "\\")) {
        current += input[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    current += char;
  }

  pushCurrent();
  return args;
}

export function linesToArgs(value?: string) {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
