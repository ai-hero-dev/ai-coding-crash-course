import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { BarChart3, Star } from "lucide-react";
import type { Overview, RevenuePoint } from "~/services/analyticsService";
import {
  ANALYTICS_RANGE_LABELS,
  PLATFORM_FEE_RATE,
  type AnalyticsRange,
} from "~/lib/analytics";
import { formatCents } from "~/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import { PanelEmpty, tableHeadClass } from "~/components/analytics/shared";

// ─── Analytics: Overview tab ───
// The cross-course panels. Each takes one key of getOverview's result.

function MoneyFigure({
  label,
  description,
  cents,
}: {
  label: string;
  description: string;
  cents: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          {formatCents(cents)}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

function RevenueFigures({ revenue }: { revenue: Overview["revenue"] }) {
  const feePercent = Math.round(PLATFORM_FEE_RATE * 100);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <MoneyFigure
        label="Gross revenue"
        description="Total paid by buyers, before any fee."
        cents={revenue.grossCents}
      />
      <MoneyFigure
        label={`Platform fee (${feePercent}%)`}
        description="The platform's cut of gross revenue."
        cents={revenue.feeCents}
      />
      <MoneyFigure
        label="Net earnings"
        description="Gross revenue minus the platform fee. Not a payout."
        cents={revenue.netCents}
      />
    </div>
  );
}

const revenueChartConfig = {
  grossCents: { label: "Gross revenue", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** "2026-06-14" → "Jun 14"; "2026-06" → "Jun 2026". */
function formatPeriod(period: string): string {
  const isMonth = period.length === 7;
  const date = new Date(
    isMonth ? `${period}-01T00:00:00Z` : `${period}T00:00:00Z`
  );
  return date.toLocaleDateString(
    "en-US",
    isMonth
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" }
  );
}

function RevenueChart({
  points,
  range,
}: {
  points: RevenuePoint[];
  range: AnalyticsRange;
}) {
  const hasSales = points.some((point) => point.grossCents > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue over time</CardTitle>
        <CardDescription>
          Gross revenue per {range === "all" ? "month" : "day"},{" "}
          {ANALYTICS_RANGE_LABELS[range].toLowerCase()}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasSales ? (
          <ChartContainer config={revenueChartConfig} className="h-72 w-full">
            <BarChart data={points} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="period"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={formatPeriod}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={72}
                tickFormatter={(cents: number) => formatCents(cents)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) =>
                      formatPeriod(String(payload[0]?.payload?.period ?? ""))
                    }
                    formatter={(value) => (
                      <div className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">
                          Gross revenue
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatCents(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar
                dataKey="grossCents"
                fill="var(--color-grossCents)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-72 flex-col items-center justify-center text-center">
            <BarChart3 className="mb-3 size-10 text-muted-foreground/50" />
            <p className="font-medium">No sales in this period</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Sales appear here as soon as someone buys a course. Try a longer
              range.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CountFigure({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

function AudienceFigures({
  audience,
  range,
}: {
  audience: Overview["audience"];
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <CountFigure
        label="Buyers"
        value={String(audience.buyers)}
        description={
          audience.buyers === 0
            ? `No one bought a course ${period}.`
            : `Distinct people who paid, ${period}. A team buyer counts once.`
        }
      />
      <CountFigure
        label="Students"
        value={String(audience.students)}
        description={
          audience.students === 0
            ? `No one enrolled ${period}.`
            : `Distinct people who enrolled, ${period}, by purchase or team seat.`
        }
      />
      <CountFigure
        label="Revenue per student"
        value={formatCents(audience.revenuePerStudentCents)}
        description={
          audience.students === 0
            ? "Shown once students enrol."
            : "What each enrolled student brought in. Team seats count at their share of the team purchase."
        }
      />
    </div>
  );
}

function TopBuyers({
  buyers,
  range,
}: {
  buyers: Overview["topBuyers"];
  range: AnalyticsRange;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top buyers</CardTitle>
        <CardDescription>
          The ten biggest spenders across your courses,{" "}
          {ANALYTICS_RANGE_LABELS[range].toLowerCase()}. Worth a personal
          message.
        </CardDescription>
      </CardHeader>
      <CardContent className={buyers.length === 0 ? undefined : "p-0"}>
        {buyers.length === 0 ? (
          <PanelEmpty
            title="No buyers in this period"
            body="Your biggest customers appear here once people buy. Try a longer range."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-border bg-muted/50">
                  <th className={tableHeadClass}>#</th>
                  <th className={tableHeadClass}>Buyer</th>
                  <th className={tableHeadClass}>Seats</th>
                  <th className={`${tableHeadClass} text-right`}>
                    Total spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((buyer, index) => (
                  <tr
                    key={buyer.userId}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{buyer.name}</span>
                        {buyer.isTeamBuyer && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                            Team
                          </span>
                        )}
                        {!buyer.enrolled && (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Not enrolled
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {buyer.email}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {buyer.isTeamBuyer ? (
                        <>
                          Bought {buyer.seats}
                          {buyer.unredeemedSeats > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              , {buyer.unredeemedSeats} unused
                            </span>
                          ) : (
                            ", all used"
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatCents(buyer.totalSpentCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const QUESTIONS_ALL_TIME_NOTE =
  "All time: a question waits until it is answered, however old it is.";

function ActionFigures({
  seats,
  unansweredQuestions,
  range,
}: {
  seats: Overview["seats"];
  unansweredQuestions: number;
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Unanswered questions</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {unansweredQuestions}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {unansweredQuestions === 0 ? (
            `No student is waiting on an answer. ${QUESTIONS_ALL_TIME_NOTE}`
          ) : (
            <>
              Questions that no one on staff has answered.{" "}
              {QUESTIONS_ALL_TIME_NOTE}{" "}
              <Link
                to="/instructor/questions"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Answer them
              </Link>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Unredeemed team seats</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {seats.unredeemed}
            {seats.sold > 0 && (
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                of {seats.sold}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {seats.sold === 0
            ? `No team seats were sold ${period}.`
            : `Seats bought by teams ${period} that no one has claimed. Chase the team buyers above.`}
        </CardContent>
      </Card>
    </div>
  );
}

function Ratings({
  ratings,
  range,
}: {
  ratings: Overview["ratings"];
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Course ratings</CardTitle>
        <CardDescription>
          {ratings.average === null
            ? `Ratings given ${period}.`
            : `${ratings.average} out of 5 from ${ratings.count} rating${ratings.count === 1 ? "" : "s"} given ${period}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className={ratings.count === 0 ? undefined : "p-0"}>
        {ratings.count === 0 ? (
          <PanelEmpty
            title="No ratings in this period"
            body="Students rate a course from its page. Ratings appear here as they come in."
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-y border-border bg-muted/50">
                <th className={tableHeadClass}>Course</th>
                <th className={`${tableHeadClass} text-right`}>Average</th>
                <th className={`${tableHeadClass} text-right`}>Ratings</th>
              </tr>
            </thead>
            <tbody>
              {ratings.courses.map((course) => (
                <tr
                  key={course.courseId}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 font-medium">{course.title}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {course.average === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Star className="size-3.5 fill-amber-400 text-amber-400" />
                        {course.average.toFixed(1)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {course.count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/** The cross-course roll-up: one panel per key of `overview`. */
export function OverviewTab({
  overview,
  range,
}: {
  overview: Overview;
  range: AnalyticsRange;
}) {
  return (
    <div className="space-y-6">
      <RevenueFigures revenue={overview.revenue} />
      <RevenueChart points={overview.revenueOverTime} range={range} />
      <AudienceFigures audience={overview.audience} range={range} />
      <TopBuyers buyers={overview.topBuyers} range={range} />
      <ActionFigures
        seats={overview.seats}
        unansweredQuestions={overview.unansweredQuestions}
        range={range}
      />
      <Ratings ratings={overview.ratings} range={range} />
    </div>
  );
}
