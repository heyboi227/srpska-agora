import type { ScoreBreakdown } from "@/lib/db/schema/scheduler";
import { TableScroll, TD, TH, TR } from "./table-scroll";

const number = new Intl.NumberFormat("sr-Latn-RS", { maximumFractionDigits: 3 });

/** The score breakdown as a native disclosure with a small table inside. */
export function Breakdown({
  breakdown,
  summary = "Rastavljanje ocene",
}: {
  breakdown: ScoreBreakdown;
  summary?: string;
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-text-muted">{summary}</summary>
      <div className="mt-2">
        <TableScroll label="Rastavljanje ocene">
          <table className="w-full min-w-[28rem] text-xs">
            <thead>
              <tr>
                <th className={TH}>Faktor</th>
                <th className={TH}>Vrednost</th>
                <th className={TH}>Težina</th>
                <th className={TH}>Doprinos</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.features.map((f) => (
                <tr key={f.key} className={TR}>
                  <td className={TD}>{f.label}</td>
                  <td className={TD}>{number.format(f.value)}</td>
                  <td className={TD}>{number.format(f.weight)}</td>
                  <td className={TD}>{number.format(f.contribution)}</td>
                </tr>
              ))}
              <tr className={TR}>
                <td className={TD} colSpan={3}>
                  Osnova
                </td>
                <td className={TD}>{number.format(breakdown.base)}</td>
              </tr>
              <tr className={TR}>
                <td className={TD} colSpan={3}>
                  Činilac budžetske faze
                </td>
                <td className={TD}>× {number.format(breakdown.stageFactor)}</td>
              </tr>
              <tr className={`${TR} font-semibold`}>
                <td className={TD} colSpan={3}>
                  Ukupno
                </td>
                <td className={TD}>{number.format(breakdown.total)}</td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
      </div>
    </details>
  );
}
