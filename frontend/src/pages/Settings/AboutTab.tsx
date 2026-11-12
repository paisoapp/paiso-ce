import { useNavigate } from "react-router-dom";
import { useOnboarding } from "@/components/onboarding/useOnboarding";
import { Button } from "@/components/ui/button";
import { HostedPromo } from "@/components/auth/HostedPromo";
import { useAppInfo } from "@/hooks/useAppInfo";
import { LEGAL_LINK_PROPS, LICENSE_URL, SOURCE_URL, THIRD_PARTY_LICENSES_URL } from "@/lib/legal";

const cardCls = "rounded-xl border border-border bg-card p-5";
const rowCardCls = `flex flex-wrap items-center justify-between gap-3 ${cardCls}`;
const linkCls = "text-primary hover:underline";

/** Which build this is, the licence it ships under and where its source is
 *  (AGPL-3.0 section 13), what leaves the server, and the software Paiso is
 *  built on. */
export function AboutTab() {
  const navigate = useNavigate();
  const { restart } = useOnboarding();
  const { data: info } = useAppInfo();

  return (
    // A stack of cards, as on the other Settings tabs.
    <div className="space-y-6 max-w-5xl">
      {/* First: the one thing on this page that is an offer, not a fact. */}
      <HostedPromo prominent />

      <div className={rowCardCls}>
        <div>
          <h3 className="text-base font-medium">Paiso Community Edition</h3>
          <p className="text-sm text-muted-foreground">
            Version {info?.version_string ?? "unknown"}. Include it when you report a problem.
          </p>
        </div>
        <a href={`${SOURCE_URL}/issues`} {...LEGAL_LINK_PROPS} className={`text-sm ${linkCls}`}>
          Report a problem
        </a>
      </div>

      <div className={`space-y-3 ${cardCls}`}>
        <h3 className="text-base font-medium">Free software</h3>
        <p className="text-sm text-muted-foreground">
          Paiso is free software under the GNU Affero General Public License, version 3. You can run it,
          study it, change it and share it. If you run a changed copy for other people over a network, the
          license requires you to offer them its source code.
        </p>
        <div className="flex flex-wrap gap-4 text-sm">
          <a href={SOURCE_URL} {...LEGAL_LINK_PROPS} className={linkCls}>Source code</a>
          <a href={LICENSE_URL} {...LEGAL_LINK_PROPS} className={linkCls}>License terms (AGPL-3.0)</a>
          <a href={THIRD_PARTY_LICENSES_URL} {...LEGAL_LINK_PROPS} className={linkCls}>Third-party licenses</a>
        </div>
      </div>

      {/* The not-advice disclaimer is not repeated here: the page footer
          carries it on every screen. */}
      <div className={`space-y-2 ${cardCls}`}>
        <h3 className="text-base font-medium">Your data</h3>
        <p className="text-sm text-muted-foreground">
          This copy of Paiso is self-hosted and keeps your data in its data volume. It sends no
          email and no usage data. It asks Yahoo Finance for prices by ticker symbol. A property photo comes
          from the Zillow link you save, and a vehicle photo from Wikipedia, found by the vehicle name.
        </p>
      </div>

      {/* Getting started */}
      <div className={rowCardCls}>
        <div>
          <h3 className="text-base font-medium">Setup guide</h3>
          <p className="text-sm text-muted-foreground">
            Open the guided walkthrough again to finish setting up your account.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            restart();
            navigate("/welcome");
          }}
        >
          Restart setup guide
        </Button>
      </div>

      <div className={`space-y-2 ${cardCls}`}>
        <h3 className="text-base font-medium">Credits</h3>
        <p className="text-sm text-muted-foreground">
          Paiso is built on open-source software, including React, Vite, Tailwind CSS, Radix UI, TanStack
          Query, Recharts, Lucide, Phosphor, FastAPI, SQLAlchemy, SQLite, APScheduler and yfinance. Thank you to the
          people who maintain them.
        </p>
      </div>
    </div>
  );
}
