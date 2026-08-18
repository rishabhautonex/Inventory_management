import type { MetadataRoute } from "next";

/**
 * Makes the app installable.
 *
 * The spec's primary user is standing at a cupboard holding a phone in one hand,
 * and there is to be "no native app, no app store". Installed to a home screen
 * this runs without the browser's URL bar and tab strip, which on a phone is two
 * rows of chrome the take-out flow was competing with — and it opens from an icon
 * rather than from a bookmark somebody has to go and find.
 *
 * `display: "standalone"` rather than `fullscreen`: the status bar stays, because
 * somebody checking stock in a lab still wants the time and their signal.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LabStock — R&D lab inventory",
    short_name: "LabStock",
    description:
      "What we have, where it is, and who took it. Search a part, take it out, log it.",
    start_url: "/",
    // Search is the landing page and the take-out flow starts there, so an
    // install that opens anywhere else opens in the wrong place.
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // The instrument-panel ground, so the splash does not flash white on a dark
    // screen before the first paint.
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
