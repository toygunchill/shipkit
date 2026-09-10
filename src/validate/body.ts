export type ParsedBody = {
  sections: Record<string, string>;
  order: string[];
};

const HEADING = /^##(?!#)\s+(.+?)\s*$/;
const SEPARATOR = /^-{3,}$/;

export function parseBody(markdown: string): ParsedBody {
  const sections: Record<string, string> = Object.create(null) as Record<string, string>;
  const order: string[] = [];
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current === null) return;
    sections[current] = buffer.join("\n").trim();
    buffer = [];
  };

  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      order.push(current);
      continue;
    }
    if (current !== null && !SEPARATOR.test(line.trim())) {
      buffer.push(line);
    }
  }
  flush();

  return { sections, order };
}
