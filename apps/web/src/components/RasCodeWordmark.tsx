const ACTIVE_CELLS = new Map(
  [
    [0, 0, 3],
    [1, 0, 2],
    [5, 0, 3],
    [8, 0, 1],
    [9, 0, 2],
    [10, 0, 3],
    [0, 1, 2],
    [2, 1, 3],
    [4, 1, 2],
    [6, 1, 3],
    [8, 1, 2],
    [0, 2, 3],
    [1, 2, 2],
    [4, 2, 3],
    [5, 2, 2],
    [6, 2, 1],
    [8, 2, 3],
    [9, 2, 2],
    [10, 2, 1],
    [0, 3, 1],
    [2, 3, 3],
    [4, 3, 1],
    [6, 3, 3],
    [10, 3, 3],
    [0, 4, 2],
    [2, 4, 1],
    [4, 4, 2],
    [6, 4, 1],
    [8, 4, 1],
    [9, 4, 2],
    [10, 4, 3],
  ].map(([column, row, level]) => [`${column},${row}`, level]),
);

const CELL_COLORS = {
  1: "var(--brand-low)",
  2: "var(--brand-medium)",
  3: "var(--brand-high)",
} as const;

const CELLS = Array.from({ length: 5 }, (_, row) =>
  Array.from({ length: 11 }, (_, column) => ({ column, row })),
).flat();

export function RasCodeWordmark() {
  return (
    <svg
      aria-label="RAS"
      className="h-4 w-auto shrink-0"
      viewBox="0 0 108 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      {CELLS.map(({ column, row }) => {
        const level = ACTIVE_CELLS.get(`${column},${row}`) as 1 | 2 | 3 | undefined;
        return (
          <rect
            height="8"
            key={`${column},${row}`}
            rx="1.5"
            style={{ fill: level === undefined ? "var(--brand-empty)" : CELL_COLORS[level] }}
            width="8"
            x={column * 10}
            y={row * 10}
          />
        );
      })}
    </svg>
  );
}
