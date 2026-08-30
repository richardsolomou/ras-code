const ACTIVE_CELLS = new Map(
  [
    [1, 1, 3],
    [2, 1, 2],
    [6, 1, 3],
    [9, 1, 1],
    [10, 1, 2],
    [11, 1, 3],
    [1, 2, 2],
    [3, 2, 3],
    [5, 2, 2],
    [7, 2, 3],
    [9, 2, 2],
    [1, 3, 3],
    [2, 3, 2],
    [5, 3, 3],
    [6, 3, 2],
    [7, 3, 1],
    [9, 3, 3],
    [10, 3, 2],
    [11, 3, 1],
    [1, 4, 1],
    [3, 4, 3],
    [5, 4, 1],
    [7, 4, 3],
    [11, 4, 3],
    [1, 5, 2],
    [3, 5, 1],
    [5, 5, 2],
    [7, 5, 1],
    [9, 5, 1],
    [10, 5, 2],
    [11, 5, 3],
  ].map(([column, row, level]) => [`${column},${row}`, level]),
);

const CELL_CLASSES = {
  1: "fill-[#216e39] dark:fill-[#006d32]",
  2: "fill-[#30a14e] dark:fill-[#26a641]",
  3: "fill-[#40c463] dark:fill-[#39d353]",
} as const;

const CELLS = Array.from({ length: 7 }, (_, row) =>
  Array.from({ length: 13 }, (_, column) => ({ column, row })),
).flat();

export function RasCodeWordmark() {
  return (
    <svg
      aria-label="RAS"
      className="h-3.5 w-auto shrink-0"
      viewBox="0 0 138 78"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        className="fill-white stroke-[#d0d7de] dark:fill-[#0d1117] dark:stroke-[#30363d]"
        height="77"
        rx="8"
        width="137"
        x="0.5"
        y="0.5"
      />
      {CELLS.map(({ column, row }) => {
        const level = ACTIVE_CELLS.get(`${column},${row}`) as 1 | 2 | 3 | undefined;
        return (
          <rect
            className={
              level === undefined ? "fill-[#ebedf0] dark:fill-[#21262d]" : CELL_CLASSES[level]
            }
            height="8"
            key={`${column},${row}`}
            rx="1.5"
            width="8"
            x={5 + column * 10}
            y={5 + row * 10}
          />
        );
      })}
    </svg>
  );
}
