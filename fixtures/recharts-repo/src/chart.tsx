import { BarChart, Bar, Cell, Tooltip } from 'recharts';
import { formatRevenue, type Slice } from './format.ts';

/**
 * Revenue chart for the analytics dashboard.
 *
 * Written against recharts 2.x, and two things here changed in recharts 3 —
 * which is exactly what Emend should detect, localise and finish:
 *
 *  - `Cell` is deprecated. It still compiles, its tests still pass, and nothing
 *    in a normal build objects, so a migration can report it and ship without
 *    removing a single use of it.
 *  - the tooltip formatter's value is no longer typed as loosely, so passing a
 *    `(value: number) => string` where the library now expects its own value
 *    type stops typechecking.
 */
export function RevenueChart({ data }: { data: Slice[] }) {
  return (
    <BarChart width={640} height={320} data={data}>
      <Tooltip formatter={formatRevenue} />
      <Bar dataKey="revenueCents">
        {data.map((slice) => (
          <Cell key={slice.id} fill={slice.colour} />
        ))}
      </Bar>
    </BarChart>
  );
}
