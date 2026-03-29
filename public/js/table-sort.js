/**
 * Client-side sortable tables: click column headers to sort (toggles asc/desc).
 */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

function parseSortableValue(text) {
  const s = (text ?? "").trim();
  if (s === "") return { kind: "empty", value: "" };
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return { kind: "time", value: t };
  const n = parseFloat(s.replace(/,/g, ""));
  if (!Number.isNaN(n) && s !== "") return { kind: "num", value: n };
  return { kind: "str", value: s };
}

function compareCells(a, b) {
  const va = parseSortableValue(a);
  const vb = parseSortableValue(b);
  if (va.kind === "empty" && vb.kind === "empty") return 0;
  if (va.kind === "empty") return 1;
  if (vb.kind === "empty") return -1;
  if (va.kind === "time" && vb.kind === "time") return va.value - vb.value;
  if (va.kind === "num" && vb.kind === "num") return va.value - vb.value;
  if (va.kind === "time" && vb.kind === "num") return va.value - vb.value;
  if (va.kind === "num" && vb.kind === "time") return va.value - vb.value;
  return collator.compare(va.value, vb.value);
}

export function initSortableTable(table) {
  if (!table || !table.tBodies.length) return;
  const tbody = table.tBodies[0];
  const headerRow = table.tHead?.rows[0];
  if (!headerRow) return;

  const headers = [...headerRow.cells];
  const sortState = { col: -1, dir: 1 };

  headers.forEach((th, colIndex) => {
    th.classList.add("sortable");
    th.setAttribute("role", "button");
    th.tabIndex = 0;
    th.title = "Click to sort";

    const runSort = () => {
      const dir =
        sortState.col === colIndex ? -sortState.dir : 1;
      sortState.col = colIndex;
      sortState.dir = dir;

      const rows = [...tbody.rows];
      rows.sort((r1, r2) => {
        const v1 = r1.cells[colIndex]?.textContent ?? "";
        const v2 = r2.cells[colIndex]?.textContent ?? "";
        return dir * compareCells(v1, v2);
      });
      rows.forEach((row) => tbody.appendChild(row));

      headers.forEach((h) => {
        h.classList.remove("sort-asc", "sort-desc");
      });
      th.classList.add(dir === 1 ? "sort-asc" : "sort-desc");
    };

    th.addEventListener("click", runSort);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        runSort();
      }
    });
  });
}
