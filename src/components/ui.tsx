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

export const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 active:scale-[0.99]";

export const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50";

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
      className={`mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8 ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  back,
  action,
}: {
  title: string;
  description?: string;
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
            className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <ArrowLeftIcon />
          </Link>
        ) : null}

        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 text-sm text-muted">{description}</p>
          ) : null}
        </div>
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** A bordered surface. The building block for every panel on every screen. */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-border bg-surface ${className}`}>
      {children}
    </div>
  );
}

/** A card with a titled header, optionally with an action on the right. */
export function Panel({
  title,
  action,
  children,
  bodyClassName = "px-4 pb-4 sm:px-5 sm:pb-5",
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </header>
      <div className={bodyClassName}>{children}</div>
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

/** The tinted rounded square that carries a stat card's icon. */
export function IconChip({
  tone = "accent",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${TONE_CHIP[tone]}`}
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
 * A stat tile: icon, optional trend, label, value.
 *
 * `trend` is deliberately optional and takes a real measured change — the
 * design shows a percentage on every tile, but a number with nothing honest to
 * compare against is better left off than invented.
 */
export function StatCard({
  icon,
  tone = "accent",
  label,
  value,
  trend,
  hint,
  href,
}: {
  icon: React.ReactNode;
  tone?: Tone;
  label: string;
  value: string | number;
  trend?: { direction: "up" | "down"; label: string };
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <IconChip tone={tone}>{icon}</IconChip>
        {trend ? (
          <span
            className={`inline-flex items-center gap-1 text-sm font-semibold ${
              trend.direction === "up" ? "text-positive" : "text-danger"
            }`}
          >
            {trend.direction === "up" ? <TrendUpIcon /> : <TrendDownIcon />}
            {trend.label}
          </span>
        ) : null}
      </div>

      <p className="mt-4 text-sm text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </>
  );

  const className =
    "block rounded-xl border border-border bg-surface p-4 sm:p-5";

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

/** Wraps a table so wide content scrolls inside the card, not the page. */
export function TableWrap({
  children,
  minWidth = 720,
}: {
  children: React.ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const theadClass =
  "border-b border-border bg-surface-muted/50 text-left text-xs font-medium text-muted";

export const thClass = "whitespace-nowrap px-4 py-3 font-medium";

export const trClass =
  "border-b border-border transition-colors last:border-0 hover:bg-surface-muted/40";

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
