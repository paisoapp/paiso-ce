/**
 * Outbound links: the hosted Paiso on the marketing site, and this copy's
 * licence and source. They open in a new tab, so a person reading them in
 * the middle of signing up keeps the form they were filling in.
 *
 * The hosted Terms and Privacy Policy on paisoapp.com do not govern a copy
 * someone runs themselves, so this edition does not link them; the licence
 * (AGPL-3.0) is what applies.
 */
/** Sign-up for the hosted Paiso, offered on the sign-up page and in About:
 *  the app's own sign-up page, which the marketing site's buttons link to. */
export const HOSTED_SIGNUP_URL = "https://app.paisoapp.com/register";

/** Attributes every outbound legal link needs. */
export const LEGAL_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

/**
 * The source code of this copy of Paiso. AGPL-3.0 section 13: anyone who runs
 * a changed copy for other people over a network must offer them its source,
 * so a fork sets VITE_SOURCE_URL at build time to point at its own.
 */
export const SOURCE_URL: string = import.meta.env.VITE_SOURCE_URL || "https://github.com/paisoapp/paiso-ce";
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
/** Written into the build by scripts/third-party-licenses.mjs. */
export const THIRD_PARTY_LICENSES_URL = "/third-party-licenses.txt";
