import Link from "next/link";

import { ArrowLeftIcon, TrendDownIcon, TrendUpIcon } from "@/components/icons";

/* -------------------------------------------------------------------------- */
/* Control styles                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every interactive element is at least 44px tall (`min-h-11`), which the spec
 * calls a hard requirement rather than a nicety. Inputs sit a shade darker than
 * the card they are on, which is what separates a field from its panel in a
 * dark theme where a border alone reads as too faint.
 */
export const inputClass =
  "min-h-11 w-full rounded-lg border border-border bg-surface-muted px-3.5 text-base text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent sm:text-sm";

export const textareaClass =
  "min-h-24 w-full rounded-lg border border-border bg-surface-muted p-3.5 text-base text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent sm:text-sm";

export const selectClass = inputClass;

/**
 * The accent is a bright signal cyan, so a filled button carries dark ink
 * (`accent-foreground`) rather than white, and lightens rather than darkens on
 * hover. The ring underneath is what gives it the lit, raised look.
 */
export const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-foreground shadow-[0_1px_0_0_rgb(255_255_255/0.25)_inset,0_8px_20px_-10px_var(--accent)] transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 active:scale-[0.99]";

export const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground shadow-[0_1px_0_0_var(--panel-line)_inset] transition-colors hover:border-border-strong hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50";

/** Quiet button for row-level actions — Undo, Correct, Retire. */
export const ghostButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border bg-transparent px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

export const dangerButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-danger px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50";

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/** Standard page gutter and max width. Every screen opens with one of these. */
export function Page({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto w-full max-w-[100rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8 ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  back,
  action,
}: {
  title: string;
  description?: string;
  /** Small caps line above the title — the section this screen belongs to. */
  eyebrow?: string;
  back?: { href: string; label: string };
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {back ? (
          <Link
            href={back.href}
            aria-label={`Back to ${back.label}`}
            className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:border-border-strong hover:bg-surface-hover hover:text-foreground"
          >
            <ArrowLeftIcon />
          </Link>
        ) : null}

        <div className="min-w-0">
          {eyebrow ? (
            <p className="eyebrow mb-1 text-accent-text">{eyebrow}</p>
          ) : null}
          <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 text-sm text-muted">{description}</p>
          ) : null}
        </div>
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/**
 * A bordered surface. The building block for every panel on every screen.
 *
 * `panel` in globals.css carries the treatment — a top-lit gradient, a hairline
 * border and a 1px inner highlight — so a card never reads as a flat rectangle
 * against the near-black page.
 */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`panel rounded-xl ${className}`}>{children}</div>;
}

/** A card with a titled header, optionally with an action on the right. */
export function Panel({
  title,
  eyebrow,
  action,
  children,
  className = "",
  bodyClassName = "px-4 pb-4 sm:px-5 sm:pb-5",
}: {
  title: string;
  /** Small caps line above the title, for a panel that needs a category. */
  eyebrow?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel flex flex-col rounded-xl ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="eyebrow text-muted">{eyebrow}</p>
          ) : null}
          <h2 className="truncate text-[0.9375rem] font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className={`flex-1 pt-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Data display                                                                */
/* -------------------------------------------------------------------------- */

export type Tone = "neutral" | "accent" | "positive" | "warning" | "danger";

const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-surface-muted text-muted",
  accent: "bg-accent/15 text-accent-text",
  positive: "bg-positive/15 text-positive",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  accent: "text-accent-text",
  positive: "text-positive",
  warning: "text-warning",
  danger: "text-danger",
};

/** The CSS variable behind each tone, for SVG strokes and fills. */
export const TONE_VAR: Record<Tone, string> = {
  neutral: "var(--muted)",
  accent: "var(--accent)",
  positive: "var(--positive)",
  warning: "var(--warning)",
  danger: "var(--danger)",
};

/** The tinted rounded square that carries a stat card's icon. */
export function IconChip({
  tone = "accent",
  size = "md",
  children,
}: {
  tone?: Tone;
  size?: "sm" | "md";
  children: React.ReactNode;
}) {
  const box = size === "sm" ? "h-8 w-8 rounded-lg" : "h-11 w-11 rounded-xl";

  return (
    <span
      className={`flex shrink-0 items-center justify-center ring-1 ring-inset ring-current/15 ${box} ${TONE_CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold ${TONE_CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A badge with a status dot. Used where the colour carries meaning on its own —
 * an order's state, a request's decision — because a dot plus a word survives
 * being read by someone who cannot separate the two hues.
 */
export function StatusPill({
  tone = "neutral",
  live = false,
  children,
}: {
  tone?: Tone;
  /** Adds the pulsing halo, for a count that is current rather than historic. */
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-current/20 px-2.5 py-1 text-[11px] font-semibold ${TONE_CHIP[tone]}`}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {live ? (
          <span
            aria-hidden
            className="pulse-ring absolute inset-0 rounded-full bg-current"
          />
        ) : null}
        <span className="relative h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {children}
    </span>
  );
}

/**
 * A stat tile: label, value, optional trend, optional sparkline.
 *
 * `trend` is deliberately optional and takes a real measured change — the
 * design shows a percentage on every tile, but a number with nothing honest to
 * compare against is better left off than invented. The same goes for `spark`:
 * no series, no chart, rather than a flat line pretending to be data.
 */
export function StatCard({
  icon,
  tone = "accent",
  label,
  value,
  unit,
  trend,
  hint,
  href,
  spark,
}: {
  icon: React.ReactNode;
  tone?: Tone;
  label: string;
  value: string | number;
  /** Rendered small beside the value — "units", "lines", "₹". */
  unit?: string;
  trend?: { direction: "up" | "down"; label: string };
  hint?: string;
  href?: string;
  /** Recent history behind the number, oldest first. */
  spark?: number[];
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconChip tone={tone} size="sm">
            {icon}
          </IconChip>
          <p className="eyebrow truncate text-muted">{label}</p>
        </div>

        {trend ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ${
              trend.direction === "up"
                ? "bg-positive/12 text-positive"
                : "bg-danger/12 text-danger"
            }`}
          >
            {trend.direction === "up" ? (
              <TrendUpIcon size={14} />
            ) : (
              <TrendDownIcon size={14} />
            )}
            {trend.label}
          </span>
        ) : null}
      </div>

      <p className="readout mt-4 flex items-baseline gap-1.5 text-[2rem] font-bold leading-none">
        {value}
        {unit ? (
          <span className="text-sm font-medium text-muted">{unit}</span>
        ) : null}
      </p>

      {hint ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}

      {/* Pinned to the foot of the card with `mt-auto`, so a row mixing tiles
          with and without a chart still lines its charts up. */}
      {spark && spark.length > 1 ? (
        <div className="pointer-events-none -mx-4 -mb-4 mt-auto pt-4 sm:-mx-5 sm:-mb-5">
          <Sparkline values={spark} tone={tone} />
        </div>
      ) : null}
    </>
  );

  const className =
    "panel relative flex flex-col overflow-hidden rounded-xl p-4 sm:p-5";

  if (href) {
    return (
      <Link
        href={href}
        className={`${className} transition-colors hover:border-border-strong hover:bg-surface-hover`}
      >
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}

/* -------------------------------------------------------------------------- */
/* Charts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Catmull-Rom through the points, converted to cubic beziers.
 *
 * A polyline through daily counts reads as jagged noise; the same points as a
 * spline read as a trend. The control points are derived from the neighbours,
 * so the curve still passes through every measured value — it is smoothing the
 * line between readings, never the readings themselves.
 */
function splinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;

  let d = `M ${points[0]!.x} ${points[0]!.y}`;

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;

    // 1/6 is the standard Catmull-Rom-to-bezier tension.
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  return d;
}

/** A bare trend line, no axes — the strip along the foot of a stat card. */
export function Sparkline({
  values,
  tone = "accent",
  height = 40,
}: {
  values: number[];
  tone?: Tone;
  height?: number;
}) {
  const width = 240;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: height - 4 - ((value - min) / span) * (height - 10),
  }));

  const line = splinePath(points);
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;
  const id = `spark-${tone}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-10 w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={TONE_VAR[tone]} stopOpacity="0.28" />
          <stop offset="100%" stopColor={TONE_VAR[tone]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={TONE_VAR[tone]}
        strokeWidth="1.5"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export type ChartSeries = {
  name: string;
  tone: Tone;
  values: number[];
  /** Fills the area under the curve. Off for a comparison line. */
  fill?: boolean;
};

/**
 * A smooth multi-series line chart with a value axis and a legend.
 *
 * Drawn as an SVG at a fixed viewBox and scaled to its container, so it is
 * responsive without a resize observer and renders on the server — no chart
 * library, no client bundle, no layout flash on load.
 */
export function SplineChart({
  labels,
  series,
  yTicks = 4,
  height = 220,
}: {
  labels: string[];
  series: ChartSeries[];
  yTicks?: number;
  height?: number;
}) {
  const width = 760;
  const padding = { top: 16, right: 12, bottom: 26, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const all = series.flatMap((s) => s.values);
  const rawMax = Math.max(...all, 1);
  // Round the axis up to something a person would have chosen, so the gridlines
  // land on whole numbers instead of 3.7.
  const step = Math.max(1, Math.ceil(rawMax / yTicks));
  const max = step * yTicks;

  const xAt = (index: number) =>
    padding.left +
    (labels.length > 1 ? (index / (labels.length - 1)) * plotWidth : plotWidth / 2);
  const yAt = (value: number) =>
    padding.top + plotHeight - (value / max) * plotHeight;

  // Enough labels to orient, never so many that they collide.
  const labelEvery = Math.max(1, Math.ceil(labels.length / 7));

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`${series.map((s) => s.name).join(" and ")} over ${labels.length} days`}
      >
        <defs>
          {series.map((s) => (
            <linearGradient
              key={s.name}
              id={`area-${s.name.replace(/\W+/g, "")}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={TONE_VAR[s.tone]} stopOpacity="0.26" />
              <stop offset="100%" stopColor={TONE_VAR[s.tone]} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const value = step * i;
          const y = yAt(value);
          return (
            <g key={value}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="var(--chart-grid)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={padding.left - 8}
                y={y + 3.5}
                textAnchor="end"
                fill="var(--muted)"
                fontSize="10"
                fontWeight="500"
              >
                {value}
              </text>
            </g>
          );
        })}

        {labels.map((label, index) =>
          index % labelEvery === 0 || index === labels.length - 1 ? (
            <text
              key={label + index}
              x={xAt(index)}
              y={height - 8}
              textAnchor={
                index === 0
                  ? "start"
                  : index === labels.length - 1
                    ? "end"
                    : "middle"
              }
              fill="var(--muted)"
              fontSize="10"
              fontWeight="500"
            >
              {label}
            </text>
          ) : null,
        )}

        {series.map((s) => {
          const points = s.values.map((value, index) => ({
            x: xAt(index),
            y: yAt(value),
          }));
          const line = splinePath(points);
          const key = s.name.replace(/\W+/g, "");

          return (
            <g key={s.name}>
              {s.fill !== false ? (
                <path
                  d={`${line} L ${xAt(s.values.length - 1)} ${padding.top + plotHeight} L ${padding.left} ${padding.top + plotHeight} Z`}
                  fill={`url(#area-${key})`}
                />
              ) : null}
              <path
                d={line}
                fill="none"
                stroke={TONE_VAR[s.tone]}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="draw-line"
                style={{ ["--dash" as string]: "2400" }}
                vectorEffect="non-scaling-stroke"
              />
              {/* An invisible target over each reading, carrying the figure as
                  a native tooltip — a chart you cannot read exact values off
                  is decoration, and this costs no client JavaScript. */}
              {points.map((point, index) => (
                <circle
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r="8"
                  fill="transparent"
                >
                  <title>{`${labels[index]} · ${s.name}: ${s.values[index]}`}</title>
                </circle>
              ))}
              <circle
                cx={points[points.length - 1]?.x ?? 0}
                cy={points[points.length - 1]?.y ?? 0}
                r="3.5"
                fill={TONE_VAR[s.tone]}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            </g>
          );
        })}
      </svg>

      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        {series.map((s) => (
          <span
            key={s.name}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted"
          >
            <span
              aria-hidden
              className="h-0.5 w-4 rounded-full"
              style={{ background: TONE_VAR[s.tone] }}
            />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/**
 * A radial gauge — one value against a maximum, drawn as a 270° arc.
 *
 * The gap at the bottom is what distinguishes it from a pie: a full ring reads
 * as a proportion of a whole, an open arc reads as a reading on a dial.
 */
export function RadialGauge({
  value,
  max,
  tone = "accent",
  label,
  caption,
  size = 148,
}: {
  value: number;
  max: number;
  tone?: Tone;
  /** The big figure in the middle. Defaults to the value itself. */
  label?: string;
  caption?: string;
  size?: number;
}) {
  const safeMax = max > 0 ? max : 1;
  const fraction = Math.max(0, Math.min(1, value / safeMax));

  const stroke = 10;
  const radius = (size - stroke) / 2 - 2;
  const centre = size / 2;
  const sweep = 270;
  const start = 135;

  const arc = (fromDeg: number, toDeg: number) => {
    const toXY = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return [centre + radius * Math.cos(rad), centre + radius * Math.sin(rad)];
    };
    const [x1, y1] = toXY(fromDeg);
    const [x2, y2] = toXY(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          role="img"
          aria-label={`${label ?? value} of ${max}${caption ? ` — ${caption}` : ""}`}
        >
          <path
            d={arc(start, start + sweep)}
            fill="none"
            stroke="var(--surface-muted)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          {fraction > 0 ? (
            <path
              d={arc(start, start + sweep * fraction)}
              fill="none"
              stroke={TONE_VAR[tone]}
              strokeWidth={stroke}
              strokeLinecap="round"
              style={{
                filter: `drop-shadow(0 0 6px color-mix(in srgb, ${TONE_VAR[tone]} 55%, transparent))`,
              }}
            />
          ) : null}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`readout text-3xl font-bold ${TONE_TEXT[tone]}`}>
            {label ?? value}
          </span>
          {caption ? (
            <span className="mt-0.5 text-xs text-muted">{caption}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * An activity heatmap: rows of buckets, opacity carrying the count.
 *
 * Cells scale to the busiest bucket, so a quiet lab still shows its shape
 * rather than a uniformly dark grid. Every cell carries its own tooltip,
 * because a heatmap without exact figures is decoration.
 */
export function Heatmap({
  rows,
  columnLabels,
  tone = "accent",
}: {
  rows: Array<{ label: string; values: number[] }>;
  columnLabels: string[];
  tone?: Tone;
}) {
  const peak = Math.max(1, ...rows.flatMap((row) => row.values));

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[26rem]">
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-right text-[10px] font-medium uppercase tracking-wide text-muted">
                {row.label}
              </span>
              <div className="flex flex-1 gap-1">
                {row.values.map((value, index) => {
                  // A square root rather than a linear ramp: one busy hour
                  // otherwise flattens every ordinary one to invisible.
                  const intensity = value === 0 ? 0 : Math.sqrt(value / peak);
                  return (
                    <div
                      key={index}
                      title={`${row.label} ${columnLabels[index] ?? ""} · ${value} movement${value === 1 ? "" : "s"}`}
                      className="h-6 flex-1 rounded-[3px] border border-border/60 transition-transform hover:scale-110"
                      style={{
                        background:
                          value === 0
                            ? "var(--surface-muted)"
                            : `color-mix(in srgb, ${TONE_VAR[tone]} ${Math.round(14 + intensity * 86)}%, transparent)`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-2 pl-11">
          {columnLabels.map((label, index) => (
            <span
              key={label + index}
              className="flex-1 text-center text-[10px] font-medium text-muted"
            >
              {index % 2 === 0 ? label : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Horizontal meter. Used for stock-against-minimum on the dashboard. */
export function ProgressBar({
  value,
  max,
  tone = "accent",
  label,
}: {
  value: number;
  max: number;
  tone?: Tone;
  label?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const percent = Math.max(0, Math.min(100, (value / safeMax) * 100));

  const fill: Record<Tone, string> = {
    neutral: "bg-muted",
    accent: "bg-accent",
    positive: "bg-positive",
    warning: "bg-warning",
    danger: "bg-danger",
  };

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full ${fill[tone]}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tables and states                                                           */
/* -------------------------------------------------------------------------- */

/** Wraps a table so wide content scrolls inside the card, not the page. */
export function TableWrap({
  children,
  minWidth = 720,
}: {
  children: React.ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="panel overflow-x-auto rounded-xl">
      <table className="w-full text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const theadClass =
  "border-b border-border bg-surface-muted/50 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted";

export const thClass = "whitespace-nowrap px-4 py-3 font-semibold";

export const trClass =
  "border-b border-border transition-colors last:border-0 hover:bg-surface-hover/60";

export const tdClass = "px-4 py-3 align-middle";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span
        aria-hidden
        className="mb-4 h-10 w-10 rounded-xl border border-border bg-surface-muted"
      />
      <p className="text-base font-medium">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Shown in place of a page body when the signed-in role may not see it. */
export function NoAccess({ children }: { children: string }) {
  return (
    <Page>
      <Card className="px-6 py-14 text-center">
        <p className="text-base font-medium">Not available to your role</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p>
      </Card>
    </Page>
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                       */
/* -------------------------------------------------------------------------- */

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">
        {label}
        {required ? (
          <span className="ml-0.5 text-accent-text" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function ErrorText({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
    >
      {children}
    </p>
  );
}
