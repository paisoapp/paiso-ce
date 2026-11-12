import { useEffect, useState, type ReactNode } from "react";
import {
  ChartLine, ChartPie, Gauge, LayoutDashboard, Lock, TrendingUp, Wallet,
} from "@/lib/icons";
import { PaisoLogo, PaisoMark } from "@/components/brand/PaisoLogo";
import { ModeToggle } from "@/components/ui/ModeToggle";
import { slotColor } from "@/lib/chartPalette";
import { balanceAfterPayments, computePayoffInfo, monthlyPrincipalAndInterest } from "@/lib/loanPayoff";
import { useThemeStore } from "@/store/theme";

// What Paiso gives a person, said before anything about how it works. The
// sign-up draft (docs/implemented/signup-flow-and-page.md) asks for the value first
// and no mention of bank links or read-only access here.
const BENEFITS = [
  { icon: Gauge, text: "Net worth, investments and budgeting together" },
  { icon: LayoutDashboard, text: "Comprehensive view of your finances" },
  { icon: Lock, text: "Encrypted data. No ads, and your data is never sold" },
];

/** A line chart path through sample points, for the backdrop and the preview. */
function sparkPath(points: number[], width: number, height: number): string {
  const max = Math.max(...points);
  const min = Math.min(...points);
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((p - min) / (max - min || 1)) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const TREND = [62, 64, 63, 67, 70, 69, 73, 76, 74, 79, 83, 86];

/** A net worth path that climbs with some day-to-day wobble, the same every
 *  render. Sample data for the backdrop only. */
const NET_WORTH = Array.from({ length: 90 }, (_, i) =>
  500 + i * 2.6 + Math.sin(i * 0.9) * 6 + Math.sin(i * 0.23) * 14 + (i > 30 ? 25 : 0) + (i > 52 ? 18 : 0),
);
// Same colours as the real Portfolio page: the up colour of
// `NetWorthTrendChart.tsx` and the breakdown slots of `lib/chartPalette.ts`.
const NET_WORTH_UP = "#22c55e";
const BREAKDOWN: [string, number, string][] = [
  ["Cash", 19.0, "$145,291"],
  ["Brokerage", 34.2, "$261,376"],
  ["401(k)", 41.3, "$316,336"],
  ["Roth IRA", 3.6, "$27,233"],
  ["HSA", 1.9, "$14,820"],
];

function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card p-5 ${className}`}>
      {title && <div className="mb-4 text-sm font-medium">{title}</div>}
      {children}
    </div>
  );
}

/**
 * The Portfolio page as it looks after sign-up, drawn with the theme tokens
 * and the app's chart colours so it matches every theme and mode, for the
 * blurred backdrop behind the sign-up window (AppBackdrop).
 */
function PortfolioMock({ className = "" }: { className?: string }) {
  const dark = useThemeStore((s) => s.resolved) !== "light";
  const nav = ["Dashboard", "Portfolio", "Investments", "Cash Flow", "Transactions"];
  const line = sparkPath(NET_WORTH, 1000, 200);
  const area = `${line} L1000,200 L0,200 Z`;
  // The donut: one stroked circle per slice, each offset by the slices before it.
  const circumference = 2 * Math.PI * 40;
  let offset = 0;

  return (
      <div className={`flex ${className}`}>
        {/* `data-sidebar` gives it the real sidebar's colours (index.css). */}
        <div data-sidebar className="hidden w-60 shrink-0 flex-col gap-2 border-r border-border bg-card p-5 sm:flex">
          <PaisoLogo markClassName="h-8 w-8" wordmarkClassName="text-xl" className="mb-6" />
          {nav.map((n) => (
            <div key={n} className={n === "Portfolio" ? "rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground" : "px-3 py-2 text-sm text-muted-foreground"}>
              {n}
            </div>
          ))}
        </div>
        <div className="flex-1 space-y-5 bg-background p-6 lg:p-8">
          <div className="flex items-center justify-between">
            <div className="text-2xl font-semibold">Portfolio</div>
            <div className="rounded-lg border border-border px-4 py-2 text-sm">+ Add account</div>
          </div>

          <Card>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Net Worth Trend</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold">$763,268</span>
                  <span className="text-sm text-success">+$262,549 (+52.43%)</span>
                </div>
              </div>
              <div className="hidden items-center gap-2 text-xs md:flex">
                <div className="flex rounded-lg border border-border">
                  <span className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground">Trend</span>
                  <span className="px-2.5 py-1 text-muted-foreground">Bars</span>
                  <span className="px-2.5 py-1 text-muted-foreground">Sankey</span>
                </div>
                <div className="rounded-lg border border-border px-3 py-1">2026-01-01 → 2026-10-20</div>
              </div>
            </div>
            <svg viewBox="0 0 1000 200" className="mt-4 h-52 w-full" preserveAspectRatio="none">
              {[40, 90, 140].map((y) => (
                <line key={y} x1="0" x2="1000" y1={y} y2={y} stroke="hsl(var(--border))" strokeDasharray="4 4" />
              ))}
              <path d={area} fill={NET_WORTH_UP} opacity="0.12" />
              <path d={line} fill="none" stroke={NET_WORTH_UP} strokeWidth="2.5" />
            </svg>
          </Card>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              ["Net Worth", "$765,056", ""],
              ["Total Assets", "$765,056", ""],
              ["Total Liabilities", "$0", "text-destructive"],
              ["Investment Gain/Loss", "+$195,585", "text-success"],
            ].map(([k, v, tone]) => (
              <Card key={k}>
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className={`mt-1 text-2xl font-semibold ${tone}`}>{v}</div>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Asset Breakdown">
              <div className="flex items-center gap-5">
                <svg viewBox="0 0 100 100" className="h-32 w-32 shrink-0 -rotate-90">
                  {BREAKDOWN.map(([label, pct], i) => {
                    const len = (pct / 100) * circumference;
                    const el = (
                      <circle
                        key={label} cx="50" cy="50" r="40" fill="none" strokeWidth="14"
                        stroke={slotColor(i, dark)}
                        strokeDasharray={`${len} ${circumference - len}`}
                        strokeDashoffset={-offset}
                      />
                    );
                    offset += len;
                    return el;
                  })}
                </svg>
                <ul className="flex-1 space-y-1.5 text-xs">
                  {BREAKDOWN.map(([label, pct, value], i) => (
                    <li key={label} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: slotColor(i, dark) }} />
                      <span className="flex-1">{label}</span>
                      <span className="text-muted-foreground">{pct}%</span>
                      <span className="hidden xl:inline">{value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
            <Card title="Fee Analysis">
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>Expense ratio</span><span>Annual fees</span><span>Cost over 10 yrs</span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 text-lg font-semibold">
                <span>0.030%</span><span>$182</span><span>$3,248</span>
              </div>
              <div className="mt-4 h-1.5 rounded-full bg-primary" />
              <div className="mt-4 space-y-2 text-sm">
                {[["VOO", "$130/yr"], ["VTIAX", "$16/yr"], ["AGG", "$15/yr"]].map(([t, v]) => (
                  <div key={t} className="flex justify-between border-b border-border pb-1.5">
                    <span className="font-medium">{t}</span><span>{v}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Assets & Debts">
              <div className="space-y-2.5 text-sm">
                {[["Cash", "$145,291"], ["Investments", "$619,765"], ["Property", "$0"], ["Other assets", "$0"], ["Outstanding loans", "$0"], ["Credit cards", "$0"]].map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-muted-foreground">{k}</span><span className="font-medium">{v}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {([
            ["Cash & Bank Accounts", [["High Yield Savings (5521)", "Savings", "$126,841"], ["Primary Checking (1842)", "Checking", "$18,451"]]],
            ["Investments", [["529 College Savings (5291)", "Brokerage", "$117,182"], ["Employee Stock Plan (8834)", "Brokerage", "$70,207"], ["401(k) (3310)", "401(k)", "$316,336"], ["Roth IRA (7702)", "Roth IRA", "$27,233"]]],
          ] as [string, string[][]][]).map(([group, rows]) => (
            <Card key={group} title={group}>
              <div className="space-y-3 text-sm">
                {rows.map(([a, t, v]) => (
                  <div key={a} className="grid grid-cols-3 items-center border-t border-border pt-3">
                    <span className="font-medium">{a}</span>
                    <span className="justify-self-center rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">{t}</span>
                    <span className="justify-self-end font-medium">{v}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>
  );
}

/** The Portfolio page blurred behind the sign-up window. Decoration only:
 *  hidden from screen readers and from the pointer. */
function AppBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      <PortfolioMock className="h-full scale-105 blur-[7px]" />
      {/* Quiets the app so the window stands out: a wash in the page colour
          lowers its contrast, then a dim, a little deeper in the dark and
          gray modes. The owner found it noisy at full strength. */}
      <div className="absolute inset-0 bg-background/45" />
      <div className="absolute inset-0 bg-black/20 dark:bg-black/30 [.gray_&]:bg-black/30" />
    </div>
  );
}

/** One period of a soft wave, drawn twice side by side so sliding the layer
 *  left by half its width loops without a seam. */
function wavePath(amplitude: number, base: number): string {
  const period = 1200;
  const pts: string[] = [];
  for (let x = 0; x <= period * 2; x += 40) {
    const y = base + Math.sin((x / period) * Math.PI * 2) * amplitude;
    pts.push(`${x},${y.toFixed(1)}`);
  }
  return `M0,400 L${pts.join(" L")} L${period * 2},400 Z`;
}

/**
 * Slow waves drifting across the bottom of the sign-in and password pages.
 * Three layers at different speeds and directions overlap into a gentle ripple. Colours and
 * motion live in index.css (`.auth-ripple`); motion stops for anyone who
 * asks the system for reduced motion.
 */
function RippleBackdrop() {
  return (
    <div aria-hidden className="auth-ripple">
      <svg className="wave-a" viewBox="0 0 2400 400" preserveAspectRatio="none">
        <path d={wavePath(40, 180)} />
      </svg>
      <svg className="wave-b" viewBox="0 0 2400 400" preserveAspectRatio="none">
        <path d={wavePath(55, 230)} />
      </svg>
      <svg className="wave-c" viewBox="0 0 2400 400" preserveAspectRatio="none">
        <path d={wavePath(30, 280)} />
      </svg>
    </div>
  );
}

/** The frame every value card shares: the page colours (so it reads as a
 *  piece of the real app on the coloured pane), a title, and a "Sample" tag
 *  so nobody takes the numbers for their own. */
function ValueCard({ title, children, nudge }: { title: string; children: ReactNode; nudge: string }) {
  return (
    <div className="rounded-lg bg-background p-4 text-foreground shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{title}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Sample</span>
      </div>
      {children}
      <p className="mt-3 text-xs text-muted-foreground">{nudge}</p>
    </div>
  );
}

function Row({ k, v, icon: Icon }: { k: string; v: string; icon?: typeof Wallet }) {
  return (
    <li className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />} {k}
      </span>
      <span className="font-medium">{v}</span>
    </li>
  );
}

function Meter({ pct, color = "hsl(var(--success))" }: { pct: number; color?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// The sample mortgage: the loan terms a person enters in the property drawer.
const MORTGAGE = { principal: 300000, rate_apr: 3.0, term_months: 180, origination: "2021-03-10" };

function monthsSince(iso: string): number {
  const start = new Date(iso + "T00:00:00");
  const now = new Date();
  return Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const DIVIDENDS = [14, 10, 24, 12, 11, 26, 13, 12, 28, 14, 12, 25];

/**
 * The cards the sign-up pane picks from, one per visit. Each shows what a
 * part of Paiso gives you, with sample numbers.
 */
const VALUE_CARDS: { id: string; render: (dark: boolean) => ReactNode }[] = [
  {
    id: "net-worth",
    render: () => (
      <ValueCard title="Net worth" nudge="Every account in one number, updated daily.">
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold">$723,232</span>
          <span className="flex items-center gap-1 text-xs text-success">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden /> 4.1% this year
          </span>
        </div>
        <svg viewBox="0 0 240 48" className="mt-2 h-12 w-full" preserveAspectRatio="none" aria-hidden>
          <path d={sparkPath(TREND, 240, 44)} fill="none" stroke="hsl(var(--primary))" strokeWidth="2" />
        </svg>
        <ul className="mt-3 space-y-1.5 text-xs">
          <Row icon={ChartLine} k="Investments" v="$150,812" />
          <Row icon={Wallet} k="Cash" v="$32,421" />
          <Row icon={ChartPie} k="Budget left this month" v="$1,317" />
        </ul>
      </ValueCard>
    ),
  },
  {
    id: "fees",
    render: () => (
      <ValueCard title="Fund fees" nudge="See what your funds really cost you, and where to cut.">
        <div className="mt-1 text-2xl font-semibold">$182 a year</div>
        <ul className="mt-3 space-y-1.5 text-xs">
          <Row k="Cost over 10 years" v="$3,248" />
          <Row k="Weighted expense ratio" v="0.03%" />
          <Row k="Priciest fund" v="VOO, $130 a year" />
        </ul>
      </ValueCard>
    ),
  },
  {
    id: "cash-flow",
    render: (dark) => (
      <ValueCard title="Cash flow this year" nudge="Know where every dollar goes, at a glance.">
        <div className="mt-1 text-2xl font-semibold">51% saved</div>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full">
          <div style={{ width: "49%", background: slotColor(1, dark) }} />
          <div style={{ width: "51%", background: "hsl(var(--success))" }} />
        </div>
        <ul className="mt-3 space-y-1.5 text-xs">
          <Row k="Income" v="$126,600" />
          <Row k="Spent" v="$62,154" />
          <Row k="Saved" v="$64,446" />
        </ul>
      </ValueCard>
    ),
  },
  {
    id: "budget",
    render: () => {
      const month = new Date().toLocaleDateString("en-US", { month: "long" });
      return (
        <ValueCard title={`${month} budget`} nudge="Budgets that keep up with your spending on their own.">
          <div className="mt-1 text-2xl font-semibold">On track</div>
          <div className="mt-3 space-y-2 text-xs">
            {([["Groceries", 64], ["Dining", 82], ["Transportation", 40]] as [string, number][]).map(([k, pct]) => (
              <div key={k} className="space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">{k}</span><span>{pct}%</span></div>
                <Meter pct={pct} color={pct > 80 ? "hsl(var(--warning))" : undefined} />
              </div>
            ))}
          </div>
        </ValueCard>
      );
    },
  },
  {
    id: "dividends",
    render: () => (
      <ValueCard title="Dividends this year" nudge="Track every payout and reinvestment, month by month.">
        <div className="mt-1 text-2xl font-semibold">$4,812</div>
        <svg viewBox="0 0 240 48" className="mt-2 h-12 w-full" preserveAspectRatio="none" aria-hidden>
          {DIVIDENDS.map((h, i) => (
            <rect key={i} x={i * 20 + 3} y={48 - h * 1.6} width="14" height={h * 1.6} rx="2" fill="hsl(var(--success))" />
          ))}
        </svg>
      </ValueCard>
    ),
  },
  {
    id: "mortgage",
    render: () => {
      // Worked out the way the property drawer does it, from the loan terms
      // alone, so the date matches what the app would show for this loan.
      const paid = monthsSince(MORTGAGE.origination);
      const balance = balanceAfterPayments(MORTGAGE.principal, MORTGAGE.rate_apr, MORTGAGE.term_months, paid);
      const payoff = computePayoffInfo(MORTGAGE, 0, null, null);
      const pct = Math.round((1 - balance / MORTGAGE.principal) * 100);
      return (
        <ValueCard title="Mortgage payoff" nudge="Know the month your home is yours, from your loan terms.">
          <div className="mt-1 text-2xl font-semibold">{payoff.payoffDateStr}</div>
          <div className="mt-3"><Meter pct={pct} /></div>
          <ul className="mt-3 space-y-1.5 text-xs">
            <Row k="Paid off so far" v={`${pct}%`} />
            <Row k="Balance left" v={money(balance)} />
            <Row
              k="Monthly payment"
              v={money(monthlyPrincipalAndInterest(MORTGAGE.principal, MORTGAGE.rate_apr, MORTGAGE.term_months))}
            />
          </ul>
        </ValueCard>
      );
    },
  },
];

const LAST_CARD_KEY = "paiso-signup-card";

/** Which card to show this visit: one at random, never the one shown last
 *  time on this browser. Chosen once, on the sign-up pane only. */
function useValueCard(enabled: boolean) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || id !== null) return;
    let pool = VALUE_CARDS;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_CARD_KEY);
    } catch {
      /* storage blocked: any card will do */
    }
    if (pool.length > 1) pool = pool.filter((c) => c.id !== last);
    const card = pool[Math.floor(Math.random() * pool.length)];
    try {
      localStorage.setItem(LAST_CARD_KEY, card.id);
    } catch {
      /* not remembered this time */
    }
    setId(card.id);
  }, [enabled, id]);
  return VALUE_CARDS.find((c) => c.id === id) ?? null;
}

/**
 * The frame around the signed-out screens: the app, blurred and dimmed, with a
 * window over it. The form is on the left; the right pane carries the logo,
 * what Paiso gives, and a preview of the app. Below `md` the window fills the
 * width and the right pane folds to a strip above the form.
 */
export function AuthShell({
  children,
  backdrop = "app",
}: {
  children: ReactNode;
  /** `app`: the two-pane window over the blurred Portfolio page (sign-up).
   *  `gradient`: the form alone on the marketing hero's gradient with a slow
   *  ripple (`.auth-hero-bg`, `.auth-ripple` in index.css). */
  backdrop?: "app" | "gradient";
}) {
  // Only the sign-up pane shows a card; the other pages never pick one.
  const card = useValueCard(backdrop === "app");
  const dark = useThemeStore((s) => s.resolved) !== "light";

  // Sign-in and the password pages: one card on the moving gradient, with the
  // logo above it. They have no right pane; the owner asked for the form alone.
  if (backdrop === "gradient") {
    return (
      <div className="relative min-h-screen overflow-hidden auth-hero-bg">
        <RippleBackdrop />
        <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 p-4 sm:p-8">
          <PaisoLogo markClassName="h-11 w-11" wordmarkClassName="text-3xl" />
          <div
            data-auth-pane="form"
            className="w-full max-w-md space-y-6 rounded-xl border border-border bg-card p-6 shadow-2xl sm:p-8"
          >
            {children}
          </div>
          {/* Signed out there is no Settings page, so the look is changed
              here. [issue 210] */}
          <ModeToggle className="bg-card shadow-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-background">
      <AppBackdrop />
      <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 p-4 sm:p-8">
        <div className="grid w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div data-auth-pane="form" className="flex flex-col">
            <div className="flex items-center gap-2 bg-primary px-5 py-3 text-primary-foreground md:hidden">
              <PaisoMark className="h-7 w-7" />
              <span className="text-sm font-medium">
                Your whole financial picture, in one private place
              </span>
            </div>
            <div className="space-y-6 p-6 sm:p-8">{children}</div>
          </div>

          <aside data-auth-pane="brand" className="hidden flex-col gap-6 bg-primary p-8 text-primary-foreground md:flex">
            <PaisoLogo markClassName="h-10 w-10" wordmarkClassName="text-2xl" />
            <h2 className="font-display text-xl font-semibold leading-snug">
              Your whole financial picture, in one private place
            </h2>
            <ul className="space-y-3">
              {BENEFITS.map(({ icon: Icon, text }) => (
                <li key={text} className="flex gap-3 text-sm leading-relaxed">
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 opacity-80" aria-hidden />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            {/* Held open while the card is picked, so the pane does not jump. */}
            <div className="min-h-[188px]">{card?.render(dark)}</div>
          </aside>
        </div>
        {/* Signed out there is no Settings page, so the look is changed
            here. [issue 210] */}
        <ModeToggle className="bg-card shadow-lg" />
      </div>
    </div>
  );
}

/** "Account, Set up", with the current step marked. This edition sends no
 *  email, so there is no step to confirm the address. */
export function SignupSteps({ current }: { current: 0 | 1 }) {
  const steps = ["Account", "Set up"];
  return (
    <ol className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Sign-up progress">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>›</span>}
          <span
            aria-current={i === current ? "step" : undefined}
            className={
              i === current
                ? "rounded-full bg-accent px-2 py-0.5 font-medium text-accent-foreground"
                : "px-1"
            }
          >
            {i + 1} {s}
          </span>
        </li>
      ))}
    </ol>
  );
}
