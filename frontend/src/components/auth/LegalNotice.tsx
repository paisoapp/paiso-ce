/**
 * Under the sign-up button: the licence this copy runs under, in place of the
 * hosted Terms and Privacy Policy, which do not govern a self-hosted copy.
 */
import { LEGAL_LINK_PROPS, LICENSE_URL } from "@/lib/legal";

export function LegalNotice() {
  return (
    <p className="text-center text-sm text-foreground/75">
      Paiso is free software under the AGPL-3.0.{" "}
      <a href={LICENSE_URL} {...LEGAL_LINK_PROPS} className="text-primary underline underline-offset-2 hover:text-primary/80">
        Read the license terms
      </a>
      .
    </p>
  );
}
